# 第 4 章 Deployment — 滚动发布的状态机

> 心智图：
>
> ```
>   Deployment (你apply的: 副本数/镜像/策略)
>        │ 期望
>        ▼
>   ReplicaSet-ⓐ (image:v1)  ←── rollback=把ⓐ副本数加回来
>        │ 创建              └── 滚动时新旧RS并存
>        ▼
>   Pod Pod Pod ...
>
#   RollingUpdate 状态机 (maxSurge/maxUnavailable 决定窗口):
#   v1:5个 → maxSurge=25%时可瞬间6个 → 起1个v2→就绪→杀1个v1→…→ v2:5个
#   全程可用副本数 ≥ (5 - maxUnavailable)   ★这就是"不停机"的数学保证
> ```

## 开篇判断

1) 滚动发布时旧 Pod 什么时候开始死？2) maxSurge 和 maxUnavailable 各牺牲什么换什么？3) 回滚的锚点是什么对象？答不清任何一题，你在生产发布时就是在赌运气。
## 4.1 两层间接：为什么 Deployment 不直接管 Pod

Deployment → ReplicaSet → Pod 的两层设计不是为了优雅，是为了**发布和回滚**：

- 每次修改 Pod 模板（image、env、command），Deployment 就**新建一个 RS**，由新旧两个 RS 交接副本。旧 RS 保留（副本数为 0），所以回滚 = `kubectl rollout undo` 秒级切回，镜像都不用重新拉。
- 只改 `replicas` 或不影响 Pod 模板的字段 → 不新建 RS，原地扩缩。**记住判据：改了 Pod 模板 = 发布；没改 = 运维操作。**

## 4.2 策略字段：maxSurge 与 maxUnavailable

```yaml
spec:
  replicas: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%          # 滚动时最多超配几个（先建新的）
      maxUnavailable: 0      # 滚动时最多少几个（先杀旧的）
  minReadySeconds: 30        # 新Pod就绪后还得稳30s才算"可用"→防"启动即崩"的假就绪
  revisionHistoryLimit: 10   # 保留几个旧RS供回滚
  progressDeadlineSeconds: 600  # 600s没进展→标记Progressing=False, CI据此判失败
```

资深开发者的选择直觉：

- **在线服务（有流量）**：`maxUnavailable: 0` + `maxSurge: 1`（或 25%）。先加后减，容量永不下降。代价是滚动期间资源峰值更高——所以 requests 要留 headroom，否则滚动卡在 Pending（第 9 章坑 1 的变体）。
- **可短暂少副本的服务**：`maxSurge: 0` + `maxUnavailable: 1`，省资源。
- **`minReadySeconds` 被严重低估**：没有它，一个"刚过 readiness 就 OOM"的 Pod 会让滚动继续，等它崩时旧 Pod 已被杀。30-60 秒的观察窗是廉价保险。
- **Recreate 策略**（全杀再全起）只用于开发环境和明确接受停机的场景。

## 4.3 发布三连与回滚

```bash
kubectl apply -f deploy.yaml
kubectl rollout status deploy/web            # 阻塞到成功或 progressDeadline 超时, CI必用
kubectl rollout history deploy/web
kubectl rollout history deploy/web --revision=3   # 看某次变更内容
kubectl rollout undo deploy/web                  # 回上一次
kubectl rollout undo deploy/web --to-revision=3   # 回指定版本
kubectl rollout restart deploy/web               # 不改模板, 只滚动重启(换Secret/排内存泄漏)
```

**CI/CD 集成范式**（对齐你熟悉的 Jenkins/GitHub Actions 世界）：

```
build镜像(不可变tag=git-sha) → push → kubectl set image deploy/web app=repo:sha 
→ kubectl rollout status (失败即fail, 不自动回滚) → 人工/自动 rollback
```

注意 `kubectl set image` 与 GitOps 的关系：set image 是命令式改动，会造成集群与 Git 漂移。正经环境用 Argo CD 之类让 Git 提交触发 apply——但底层机制完全一样。

## 4.4 谁在杀你的旧 Pod：滚动发布的时序

一次滚动中单个旧 Pod 的死亡序列（第 10 章的预告，这里先记住骨架）：

```
1. Deployment把旧RS副本数-1
2. (前提: PDB允许, 见第10章) Pod进入Terminating
3. 同时: endpoint控制器把它从Service摘除  ←与4的先后不保证! ★乱序坑的根源
4. kubelet发SIGTERM → 等terminationGracePeriodSeconds(默认30s) → SIGKILL
5. preStop钩子可以插在3和4之间买时间(见第10章)
```

如果应用收到 SIGTERM 立刻停止监听，而摘除流量晚了一步——正在处理的请求 502。这个坑在第 10 章用 preStop + graceful shutdown 收口，此处你只需知道：**"滚动发布时的偶发 502/连接拒绝"不是 K8s 的 bug，是终止协议的时序问题，可完全工程化解决**。

## 4.5 StatefulSet / DaemonSet / Job 一屏速览

同一模式的不同实例（都会在实战线用到）：

| 工作负载 | 身份语义 | 典型用途 | 关键点 |
|---|---|---|---|
| Deployment | 无身份，随机名 | Web/API 服务 | 本章 |
| StatefulSet | 稳定序号+独立PVC（web-0/1/2） | 数据库主从、Kafka、向量库 | 有序启停；扩容按序；缩容从尾部；podName=稳定DNS名 |
| DaemonSet | 每节点一个 | 日志采集、监控agent、GPU驱动组件 | 新节点自动铺；污点节点要toleration |
| Job | 跑完即止 | 批处理、训练任务、DB迁移 | `backoffLimit`重试；`completions/parallelism`控制扇出 |
| CronJob | 定时Job | 定时报表、数据ETL | `concurrencyPolicy`；⚠️时区默认是控制面的UTC |

Job 的一个高频坑：跑一次性 DB 迁移用 Job 挂在发布流水线里，若迁移失败 `backoffLimit` 会让它反复重跑——**迁移脚本必须幂等**（和你写消息消费者的思维一致）。

## Lab 4：亲眼看滚动与回滚

```bash
# 1. 部署 v1
kubectl create deployment web --image=nginx:1.26 --replicas=4
kubectl patch deployment web -p '{"spec":{"strategy":{"rollingUpdate":{"maxUnavailable":0,"maxSurge":1}}}}'
kubectl rollout status deployment/web

# 2. 另开一个终端压观测（看滚动期间始终有4个Ready）：
#    watch -n1 'kubectl get pods -l app=web --no-headers | grep -c Running'
kubectl set image deployment/web nginx=nginx:1.27
kubectl get rs -l app=web -w        # 旧RS desired从4→0, 新RS 0→4

# 3. 故意发布一个坏镜像，看 progressDeadline 生效
kubectl set image deployment/web nginx=nginx:1.27-notexist
kubectl rollout status deployment/web --timeout=30s   # 超时退出码非0 → CI判失败
kubectl rollout undo deployment/web                   # 回滚
kubectl get rs -l app=web                             # 确认回到1.27的RS

# 4. 收尾
kubectl delete deployment web
```

验证点：①滚动中 Ready 数不低于 4（maxUnavailable:0 的效果）；②坏镜像时 rollout status 超时返回非零退出码（`echo $?` 确认），undo 后 RS 恢复。

## 生产案例：滚动发布的"最后 5 秒缝隙"（行业高频模式）

readiness 通过≠流量已切换：Pod 就绪到端点下发到 kube-proxy/负载均衡器之间存在传播延迟（秒级），此时旧 Pod 可能已进入终止——偶发 5xx 的最大来源。标准兜底：maxUnavailable=0 + preStop sleep（第 10 章成体系解决；第 16 章验证时也实测过端点传播 10-20s 延迟）。

## 本章面试题

1. Deployment→RS→Pod 两层间接的价值？（历史版本=回滚锚点）
2. maxSurge/maxUnavailable 怎么配出"零停机"与"最快发布"两种姿态？（0/1 vs 1/0）
3. rollout 卡住怎么排查？（progressDeadline 超时看 Events：镜像拉取/探针失败/配额）
4. StatefulSet 与 Deployment 的本质差异场景？（稳定网络标识+独立存储，有序伸缩）

## 自测清单

- [ ] 能画出滚动发布时序图（含就绪门槛与端点传播）
- [ ] lab 里做过发布三连+回滚+坏镜像超时
- [ ] 能说出 progressDeadlineSeconds 的默认值与作用


## 相关故障卡片（动手复现版）

本章知识点对应的真实故障，可在 kind 集群亲手制造并修复：

- [17 | 发布了坏镜像：rollout 卡死与回滚](20-failures/17-坏版本rollout-一键回滚.md)
