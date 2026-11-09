# 第 3 章 Pod — 最小调度单元的真实语义

> 心智图：
>
> ```
>                    ┌──────────────── Pod (1个IP, 1组共享volume) ─────────────┐
>                    │  ┌─────────┐   ┌─────────┐      共享: network ns        │
>  Node 上被调度的 → │  │ 主容器   │ + │ sidecar │      (localhost互通, 端口冲突!)│
>  最小单位是 Pod    │  └─────────┘   └─────────┘      IPC(可共享shm)          │
>  而不是容器        │   init容器(先跑完才轮到主容器, 顺序执行, 不并存)            │
>                    └────────────────────────────────────────────────────────┘
>   生命周期: Pending → ContainerCreating → Running ⇄ (探针失败/CrashLoop) 
>             → Terminating → Succeeded/Failed
>   重启策略: Always(默认,Deployment用) / OnFailure(Job用) / Never
> ```

## 开篇判断

1) 我知道 Pod 里两个容器怎么互通（localhost？）吗？2) 我能说出至少三种 Pod 退出的"死法"吗（崩溃/OOM/被杀）？3) init 容器和普通容器的执行保证我用过吗？有"否"，本章把 Pod 从"会写 YAML"升级到"懂语义"。
## 3.1 一句话重定位：Pod = "逻辑主机"，不是"进程"

你过去的直觉：一个容器 ≈ 一个进程，独立 IP。K8s 的直觉：**Pod ≈ 一台微型虚拟机**（有自己的 IP、hostname、端口空间、卷），容器只是这台机器上的进程。两个推论：

1. **同 Pod 容器 localhost 互通**，但**端口不能冲突**（共享 network namespace）。经典的 sidecar（日志收集、service mesh envoy）就是这么工作的。
2. **Pod 是易碎品**：不给它分配可预测的名字（用 label 而不是名字找它）、不把状态放它身上（放 PVC/外部存储）、不直接对它做发布（通过 Deployment）。你几乎从不手工创建裸 Pod，就像你几乎从不手工 `new Thread()` 而是用线程池。

## 3.2 你真正会写的字段（Pod 模板精要）

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: demo-pod
  labels: { app: demo }            # label 是 K8s 里一切"选择"的基础，Service/HPA全靠它
spec:
  restartPolicy: Always
  containers:
  - name: app
    image: nginx:1.27
    ports: [ {containerPort: 80} ]  # 纯声明性文档，不写也能访问；不产生任何隔离
    resources:                      # 第 9 章整章展开，此处必须写，别裸奔
      requests: { cpu: 100m, memory: 128Mi }
      limits:   { cpu: 500m, memory: 256Mi }
    env:
    - name: LOG_LEVEL
      valueFrom: { configMapKeyRef: { name: app-cfg, key: log_level } }
    livenessProbe:  ...             # 第 10 章
    readinessProbe: ...
  - name: log-sidecar               # sidecar 与主容器同生命周期(1.29+可声明restartPolicy: Always的真sidecar)
    image: fluent-bit:3.0
```

三个高频误读：

- `containerPort` **不做任何端口映射或隔离**。集群内任何 Pod 都能访问另一个 Pod 的任意端口。网络隔离要靠 NetworkPolicy（默认全通）。
- `imagePullPolicy` 默认 `IfNotPresent`，但 `:latest` 标签默认 `Always`。CI 里用可变标签（如 `latest` 或同 tag 覆盖推送）是经典的"改了不生效"故障源——**镜像 tag 必须不可变**（用 git sha 或版本号）。
- 环境变量注入发生在**容器启动时**，ConfigMap 更新后环境变量**不会变**（只有挂载为 volume 的才会热更新，第 7 章）。

## 3.3 Pod 生命周期与退出码速查

排障时看 `kubectl get pod` 的 STATUS，对照表：

| STATUS | 含义 | 常见根因 |
|---|---|---|
| Pending | 没被调度 | 资源不足 / 亲和冲突 / taint 未容忍（`describe` 看 Events） |
| ContainerCreating | 拉镜像/挂卷中 | 镜像大、registry 慢、volume 挂载失败 |
| Running | 容器在跑 | ≠ 健康，要看 readiness |
| CrashLoopBackOff | 反复崩溃带退避重启 | 见 15 章场景 3；退避间隔 10s→20s→40s…上限 5min |
| ImagePullBackOff | 拉不到镜像 | tag 打错 / 无凭证（需 imagePullSecrets）/ registry 挂了 |
| Evicted | 被驱逐 | 节点内存压力（第 9 章 QoS） |
| OOMKilled | 容器被 cgroup OOM 杀掉 | exit code 137，limits.memory 太小或内存泄漏 |
| Terminating | 卡在终止 | finalizer 未摘 / PDB 阻挡（第 10 章） |

容器 exit code：0=正常；1=应用错误；137=SIGKILL（128+9，OOM 或 `kubectl delete pod --force` 前）；143=SIGTERM（128+15，优雅终止的正常结局）。

## 3.4 init 容器与 multi-container 模式

- **initContainer**：按序执行、全部成功才启动主容器、不并存。用途：等依赖就绪（`until nc -z db 5432; do sleep 1; done`）、预下载模型/文件到 emptyDir、注册中心注册。注意：init 容器没有探针，失败只能靠 restartPolicy 重试。
- **sidecar 模式**：日志采集（fluent-bit）、网格代理（envoy）、本地缓存（本地向量库副本）。1.29 起 init 容器可声明 `restartPolicy: Always` 成为"原生 sidecar"，解决老 sidecar 的两大痛：主容器死了 sidecar 跟着陪葬的顺序问题、job 类型 sidecar 卡住 Pod 不结束的问题。⚠️ 老集群上仍靠普通容器+启动顺序 hack。
- **Pod Topology Spread Constraints**：控制副本在拓扑域（zone/rack）的分布，多可用区部署防"一个 AZ 挂了丢一半副本"的标配，字段 `topologySpreadConstraints`，第 14 章实战中会写。

## 3.5 一个 Java 开发者的特别提醒

JVM 容器内的内存感知：JDK 8u191+ / JDK 10+ 才正确读取 cgroup limit。你在容器里 `-Xmx4g` 而 limits.memory=2Gi，结果就是 OOMKilled——**Go 应用按 cgroup 自动适配，JVM 你必须显式 `-XX:MaxRAMPercentage=75.0`（预留 25% 给堆外：metaspace、线程栈、直接内存）**。这是 Java 转 K8s 的第一大凶案现场（第 9 章场景重演）。

## Lab 3：Pod 生死观察

```bash
# 1. 起一个会崩溃的 Pod（观察 CrashLoopBackOff）
kubectl run crashy --image=busybox:1.36 --restart=Always -- /bin/sh -c 'echo start; sleep 15; exit 1'
kubectl get pod crashy -w
# 观察 RESTARTS 增长 & STATUS 变 CrashLoopBackOff；Ctrl+C
# (⚠️ sleep别低于15秒：kind/containerd 上重启太快时，上一次尝试的日志文件会被及时清理，
#  --previous 会报 unable to retrieve container logs)

kubectl describe pod crashy | sed -n '/Events/,$p'   # 看 Back-off 行
kubectl logs crashy --previous                        # ★ previous 看上一次崩溃的日志，排障神器
kubectl delete pod crashy

# 2. init 容器等待依赖
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata: { name: with-init, labels: { app: demo } }
spec:
  containers:
  - name: main
    image: busybox:1.36
    command: ["sh","-c","echo ready && sleep 300"]
  initContainers:
  - name: wait-db
    image: busybox:1.36
    command: ["sh","-c","for i in $(seq 1 3); do echo try $i; sleep 2; done; echo db-up"]
EOF
kubectl get pod with-init -w    # 先 Init:0/1 → PodInitialized → Running
kubectl logs with-init -c wait-db   # 指定容器看 init 日志

# 3. 同 Pod 容器 localhost 互通
kubectl exec with-init -c main -- sh -c 'hostname -i'   # 记下Pod IP
kubectl delete pod with-init
```

验证点：①CrashLoopBackOff 的退避节奏肉眼可见；②`--previous` 能拿到崩溃前日志；③init 容器在主容器之前串行完成。

## 生产案例：CrashLoop 日志消失的坑（本课程实测）

kind/containerd 上快崩快重启的容器，`kubectl logs --previous` 会因上一次日志文件被清理而拿不到——本课程实测（VERIFICATION.md 第 3 章记录）：sleep 5 100% 复现失败，sleep 15 稳定拿到。生产对应物：崩溃循环里抓日志要快，或用落盘 sidecar/容器运行时日志保留策略兜底。

## 本章面试题

1. Pod 里容器共享什么、不共享什么？（共享网络/IPC/卷，不共享文件系统与 PID 默认）
2. init 容器与普通容器的区别？适用场景？（顺序保证+不参与探针/服务）
3. restartPolicy 三值与 Job/CronJob 的关系？（Never 才能让失败留现场）
4. 退出码 137 vs 1 vs 143 分别意味着什么？（SIGKILL 常见 OOM / 应用错误 / SIGTERM 正常退出）

## 自测清单

- [ ] 能说清"Pod=逻辑主机"对 Java 老兵的含义（localhost 互通、共享卷）
- [ ] lab 里观察了 Pending→ContainerCreating→Running 与退出码
- [ ] 会用 --previous 抓崩溃前日志（并知道它可能已消失）


## 相关故障卡片（动手复现版）

本章知识点对应的真实故障，可在 kind 集群亲手制造并修复：

- [01 | CrashLoopBackOff：容器反复崩溃](20-failures/01-CrashLoopBackOff-容器反复崩溃.md)
- [02 | ImagePullBackOff：镜像拉不下来](20-failures/02-ImagePullBackOff-镜像拉不下来.md)
- [07 | Pending：nodeSelector 匹配不到节点](20-failures/07-Pending-nodeSelector无匹配节点.md)
- [19 | Job 失败重试：backoffLimit 与日志取证](20-failures/19-Job失败重试-backoffLimit.md)
- [20 | Init 容器卡死：主容器永远不启动](20-failures/20-Init容器卡死-主容器不启动.md)
