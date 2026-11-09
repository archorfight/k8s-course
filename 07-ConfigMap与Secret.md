# 第 7 章 ConfigMap / Secret — 配置的分发与边界

> 心智图：
>
> ```
#   ConfigMap(非敏感) / Secret(base64, 敏感性是"约定"不是"加密")
#        │ 三种注入方式, 热更新能力完全不同:
#        ├─① 环境变量 env/varFrom   启动时注入 → 更新后【永不生效】要重启Pod
#        ├─② 挂载为文件 volume       kubelet定期同步(约1分钟) → 【热更新】★
#        └─③ 容器命令args里$(VAR)    同①
#
#   12-Factor视角: K8s把"配置与代码分离"做成了API对象, 但把"配置变更生效"
#   的责任留给了你: 改ConfigMap ≠ 应用重读, 必须设计reload路径(reload或滚动重启)
> ```

## 开篇判断

1) 改了 ConfigMap，运行中的容器会感知吗（分三种注入方式）？2) Secret 的 base64 防得住谁？3) 我的配置分几层、谁在哪个环节注入？第一问答"会"是本课程实测过的最贵误解之一。
## 7.1 对象本质与大小红线

ConfigMap/Secret 就是 etcd 里的键值对（Secret 的值做 base64 编码——**编码 ≠ 加密**，`echo xxx | base64 -d` 谁都能解，真正的保密靠：RBAC 限制 get、静态加密 etcd、以及外接密管 Vault/云KMS/Sealed Secrets）。单对象上限 **1MiB**（etcd 的请求尺寸限制），大配置要拆分；日志/证书链超限时报 `Too long: must have at most 1048576 bytes`。

## 7.2 三种注入方式的语义差异（高频面试级坑）

```yaml
spec:
  containers:
  - name: app
    env:
    - name: LOG_LEVEL                        # ①单键注入
      valueFrom: { configMapKeyRef: { name: cfg, key: log_level } }
    envFrom:
    - configMapRef: { name: cfg }            # ①'全量注入为环境变量
    volumeMounts:
    - { name: cfg-vol, mountPath: /etc/app } # ②挂载为文件(支持热更新)
  volumes:
  - name: cfg-vol
    configMap: { name: cfg }
```

| 方式 | Pod 启动后改 ConfigMap | 适用 |
|---|---|---|
| env | 不生效（环境变量是进程启动属性） | 只在启动读一次的配置 |
| volume | kubelet 同步周期后文件变化（symlink 原子切换） | 配置文件（yaml/properties），配 reload 机制 |
| 不可变 `immutable: true` | 永不变（要换对象） | 高频读取的大配置，省 watch 开销 |

**工程决策树**：应用支持配置热加载（Spring Cloud Config 的 refresh、viper 的 WatchConfig）→ 用 volume + reload；不支持 → env/文件 + **改配置后 `kubectl rollout restart`**（这是最诚实简单的主流做法，别迷信热更新）。Spring Boot 的一个经典死法：Actuator `/actuator/refresh` 配了但没配 `spring.config.import: optional:configtree:/etc/app/`——K8s 的 ConfigMap volume 呈现为 configtree 文件树，Spring Boot 2.4+ 原生支持这个模式，比 env 优雅得多。

## 7.3 Secret 的正确姿势

- 基础类型：`Opaque`（通用）、`kubernetes.io/dockerconfigjson`（镜像拉取凭证，配 `imagePullSecrets`）、`kubernetes.io/tls`（证书）、`kubernetes.io/basic-auth` 等。
- **GitOps 时代的大矛盾：YAML 想进 Git，Secret 不能进 Git。** 解法光谱：
  - Sealed Secrets（公钥加密后可进 Git，集群内 controller 解密）——中小团队性价比最高；
  - External Secrets Operator（从 Vault/云 KMS/云 Secret Manager 拉取，集群里只留 ExternalSecret 指针）——正道，多环境共享密管；
  - SOPS + age（文件级加密，GitOps 工具原生支持解密）。
  - ⚠️ 直接 base64 进 Git = 明文进 Git，等于没做。
- 排障：Pod 起不来且 `describe` 显示 `CreateContainerConfigError` → 九成是引用的 ConfigMap/Secret 的 key 名不存在或对象在别的 namespace。**ConfigMap/Secret 是 namespace 级对象，跨 namespace 不共享**——和你习惯的"配置中心全局配置"不同。

## 7.4 一个完整的生产范式（配置分层）

```
基础镜像(无配置) 
  → ConfigMap: 环境无关默认值 (yaml进Git, 明文)
  → ConfigMap: 环境覆盖 (per-env overlay: kustomize的bases+overlays)
  → Secret: 凭证 (ExternalSecret指到Vault, 不进Git)
  → 极少数启动期参数: args (进Deployment模板, 改了就走发布)
```

与你熟悉的 Spring profile 对齐：`application.yml`（默认）≈ 基础 ConfigMap，`application-prod.yml` ≈ overlay ConfigMap，挂载顺序由文件路径决定，Spring Boot 的 profile 机制照常工作——迁移存量应用时把 `configtree:` 模式接上就行，不需要推翻配置体系。

## Lab 7：三种注入方式的行为差异实证

```bash
# 1. 建 ConfigMap
kubectl create configmap cfg --from-literal=log_level=INFO --from-literal=feature_x=on

# 2. 部署同时用 env + volume 的 Pod
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata: { name: cfg-demo }
spec:
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh","-c","echo env LOG_LEVEL=$LOG_LEVEL; cat /etc/app/log_level; sleep 3600"]
    env:
    - name: LOG_LEVEL
      valueFrom: { configMapKeyRef: { name: cfg, key: log_level } }
    volumeMounts: [ { name: cfg-vol, mountPath: /etc/app } ]
  volumes:
  - name: cfg-vol
    configMap: { name: cfg }
EOF
kubectl wait --for=condition=ready pod/cfg-demo --timeout=60s
kubectl logs cfg-demo | head -2    # env=INFO / 文件=INFO

# 3. 改 ConfigMap，观察两种方式的行为差异
kubectl patch configmap cfg -p '{"data":{"log_level":"DEBUG"}}'

# 立即看env（没变）:
kubectl exec cfg-demo -- sh -c 'echo env=$LOG_LEVEL'
# 等约60-90秒再看文件（kubelet同步周期）:
kubectl exec cfg-demo -- cat /etc/app/log_level     # → DEBUG ★热更新只属于volume

# 4. 确认后清理
kubectl delete pod cfg-demo && kubectl delete configmap cfg
```

验证点：同一份 ConfigMap，env 注入的值停在 INFO，volume 注入的文件变成 DEBUG——**"改了配置不生效"的第一嫌疑永远是注入方式**。生产上的标准收口：volume + 应用 reload，或干脆 `rollout restart`。

## 生产案例：env 注入不更新引发的"配置玄学"（行业高频+本课程实测）

env 方式注入的 ConfigMap 更新后**已运行的 Pod 不感知**（环境变量在进程启动时固化）；volume 挂载才会热更新（有同步延迟）。Java 应用还要多踩一层：JVM 启动时读取的 -D 参数同理不可变。"改了配置没生效重启大法"的机制根源就在这。另一红线（原文 7.1）：etcd 里 Secret 是 base64 裸奔——第 20 章 L4 给三层对策。

## 本章面试题

1. 三种注入方式在"更新语义"上的差异？（env 不更新/volume 热更新/镜像构建期固化）
2. Secret 的三层保护怎么做？（TLS 传输/etcd 加密/KMS+不进 Git）
3. 巨型 ConfigMap/Secret 的危害？（etcd 与 watch 放大，第 25 章）
4. 配置分层的生产范式？（环境公共层+环境差异层+实例层）

## 自测清单

- [ ] lab 里实证了 env 不更新与 volume 热更新
- [ ] 能一条命令证明 Secret 是明文裸奔
- [ ] 说不清"配置为什么没生效"时先查注入方式


## 相关故障卡片（动手复现版）

本章知识点对应的真实故障，可在 kind 集群亲手制造并修复：

- [03 | CreateContainerConfigError：ConfigMap 缺失](20-failures/03-CreateContainerConfigError-ConfigMap缺失.md)
- [04 | CreateContainerConfigError：Secret 缺失](20-failures/04-CreateContainerConfigError-Secret缺失.md)
