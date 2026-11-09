# 第 23 章 Operator 与 CRD — 把运维知识写成代码

## 23.1 开篇判断

Operator 是 K8s 生态里"高级感"最高的词，也是最容易被滥用的。三个判断：

1. 你们有没有这样一个有状态系统：它的运维手册有 20+ 步（备份、扩容、故障转移、版本升级的顺序与禁忌）？有，Operator 值得写。
2. 你要管理的软件是不是已有成熟 Operator（Postgres→CloudNativePG，Kafka→Strimzi，Redis→各种）？有，**用别人的，不要自己写**——自研 Operator 的维护成本远超预期，这是社区共识级的教训。
3. 你只是想抽象部署模板？那是 Helm/Kustomize（第 24 章）的活，别上 Operator。

一句话定义（面试标准答案）：**Operator = CRD（自定义资源类型，扩展 API）+ 控制器（把"期望状态"调和成"实际状态"的循环）+ 领域运维知识（启停顺序、备份、恢复）**。它的本质是把 runbook 编码成软件。

## 23.2 原理

**CRD**：向 API server 注册新资源类型（如 `postgresql.cnpg.io/v1 PostgresCluster`），API server 自动生成 REST 路径、存储（etcd）、watch 机制。CRD 的 schema（OpenAPI v3）做准入校验。关键机制细节：**最终一致性来自 watch + workqueue**：informer watch 资源变化 → 事件进 workqueue（去重）→ reconcile 函数被调 → 副作用作用于子资源（Deployment/PVC/...）→ 更新 CR 的 status。**reconcile 必须幂等**：不知道自己为什么被调用，也不该知道——每次都"读当前状态→算 diff→改到期望"。这是和事件回调编程最大的心智差异，也是新手的最大翻车点（写了非幂等的 reconcile，重入后状态机错乱）。

**控制面细节（写 Operator 前必懂的三个）**：
- **水平扩展**：一个控制器实例监听全量事件会成瓶颈，社区方案（kubebuilder 的 Controller-Ref 等）支持按 key 分片。
- **Leader 选举**：控制器多副本时只有 leader 干活，避免双重调和（`resourcelock` 机制）。
- **RBAC 最小化**：Operator 的 SA 权限=它的爆炸半径（第 20 章串联）。

**开发框架选型**：Go+kubebuilder/controller-runtime 是事实标准；Python+kopf 适合内部轻量场景；声明式方案（如 Anthos/Google 的 addon-operator 或纯 Helm+定时调和）覆盖简单需求。**成熟度自检**：一个能上生产的 Operator 至少要有——状态条件（conditions）、版本迁移（conversion webhooks）、优雅降级、备份集成。你评估第三方 Operator 时就按这四条打勾。

**别忘了一体两面**：CRD 是 API 扩展，会占据 etcd 与 API server 的 watch 带宽。命名空间级 CRD 乱建会导致 API 资源爆炸（`kubectl api-resources` 三千行的那种集群，谁都看不懂）——**每建一个 CRD 都要过架构评审**，这是平台组的纪律。

## 23.3 实操 lab：用 kopf 写一个 40 行的真正 Operator

选 Python+kopf 是刻意的：去掉语言工程细节，让你看清控制器循环的本体。（生产级请用 kubebuilder，但原理就是这个 lab。）

```bash
# 1. 装 kopf（约 30s）
pip3 install kopf kubernetes

# 2. 定义最小 CRD 与 Operator（一个文件）
cat <<'EOF' > /tmp/echoop.py
import kopf

@kopf.object.on.create('example.com', 'v1', 'echos')
def create_fn(spec, patch, **kw):
    msg = spec.get('message', 'hello')
    kopf.verb  # noqa
    print(f"[reconcile] 收到期望状态: {msg}")
    # 模拟领域逻辑：把消息反转后写回 status（真实 Operator 这里会建 Deployment/PVC）
    patch.status['reversed'] = msg[::-1]
    patch.status['phase'] = 'Done'

@kopf.object.resume('example.com', 'v1', 'echos')
def resume_fn(spec, **kw):
    # 控制器重启时的全量再调和——幂等性在这里被检验
    print(f"[resume] 控制器重启，重新调和: {spec.get('message','?')}")
EOF

# 3. 注册 CRD
cat <<'EOF' | kubectl apply -f -
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata: { name: echos.example.com }
spec:
  group: example.com
  scope: Namespaced
  names: { plural: echos, singular: echo, kind: Echo, shortNames: [eo] }
  versions:
  - name: v1
    served: true
    storage: true
    subresources: { status: {} }
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            properties:
              message: { type: string }
          status: { type: object, x-kubernetes-preserve-unknown-fields: true }
EOF

# 4. 前台起 Operator（另一个终端，或加 & ；能看到日志是重点）
python3 /tmp/echoop.py --namespace default &
sleep 5

# 5. 创建 CR，观察调和
cat <<'EOF' | kubectl apply -f -
apiVersion: example.com/v1
kind: Echo
metadata: { name: e1 }
spec: { message: "operator-loop" }
EOF
sleep 3
kubectl get echo e1 -o jsonpath='{.status}'; echo
# 预期 {"phase":"Done","reversed":"pool-rotarepo"} —— 期望→实际被调和闭环了

# 6. 幂等性检验：改 spec，观察调和被再次触发
kubectl patch echo e1 --type merge -p '{"spec":{"message":"again"}}'
sleep 3 && kubectl get echo e1 -o jsonpath='{.status.reversed}'; echo   # 预期 niaga

# 7. 控制器崩溃演练：杀掉 Operator，改 spec，重启，看 resume 全量调和
kill %1 2>/dev/null
kubectl patch echo e1 --type merge -p '{"spec":{"message":"while-down"}}'
python3 /tmp/echoop.py --namespace default &   # 重启
sleep 4 && kubectl get echo e1 -o jsonpath='{.status.reversed}'; echo
# 预期 nwod-elihw —— 控制器不在线时世界照常变，重启后靠全量调和追平。
# 这就是"声明式"的精髓：没有人在监听你，是你在不断对齐世界。
```

预期总耗时 10 分钟。第 7 步是本 lab 的灵魂：**Operator 的可靠性不来自它常在，而来自它缺席后能追平**。

## 23.4 生产案例：公开复盘与事故模式

案例一（公开可查证）：CoreOS 2016 提出 Operator 概念（etcd Operator 是首个），后来 etcd Operator 自身被官方建议生产慎用（运维复杂度转移到了 Operator 本身），CNCF 生态的共识逐渐变成：**Operator 化的收益与该软件的运维复杂度成正比，简单软件 Operator 化是负收益**。你在选型汇报里引这段历史，比引任何框架文档都有说服力。

案例二（行业通病，模式）："Operator 挂了谁知道？"自研 Operator 没有自我监控，控制器 OOM/卡死后无人发现，CR 状态停止更新。标配三件套：controller-runtime 的 workqueue 深度与 reconcile 时长暴露成 metrics、CR 的 status.conditions 有"最后调和时间"、外部 watchdog 对 stale status 告警。第 12 章可观测性在这里落地为"观测你的控制器本身"。

案例三（公开模式）：Conversion webhook 变成集群单点。CRD 多版本共存依赖 conversion webhook，webhook 挂了 → 该 CRD 的所有读写（含 kubectl get）全部失败 → 连修复它都困难。缓解：webhook 高可用+failurePolicy 配置评审（Fail 会放大故障，Ignore 有静默风险，没有好答案只有权衡）。这类"扩展 API 的自反性故障"是资深面试里区分度极高的话题。

## 23.5 本章面试题

1. Operator 的定义与适用边界？（CRD+控制器+领域知识；有状态复杂系统才值得）
2. 为什么 reconcile 必须幂等？怎么保证？（触发原因不可知/重入必然发生；只读现态算 diff，不依赖事件顺序）
3. 控制器多副本为什么要 Leader 选举？（避免双重调和副作用）
4. 自研 vs 采用现成 Operator 的决策框架？（成熟度四条：conditions/conversion/降级/备份，+维护方活跃度）
5. conversion webhook 挂了会怎样？为什么说是自反性故障？（该 CRD 读写全断，修复动作本身依赖故障组件）
6. CRD 滥用的代价？（API 资源爆炸、etcd/watch 带宽、权限面扩大）

## 23.6 自测清单

- [ ] 能一口气说出 Operator 三要素
- [ ] lab 里体验了 create/patch/重启追平三种调和触发
- [ ] 能解释 workqueue 去重与 informer watch 的关系
- [ ] 评估第三方 Operator 会打四条成熟度勾
- [ ] 能给自研 Operator 设计自我监控三件套

> 调研粮备注：kopf lab 未在 kind 上全量实测（框架版本可能有 API 变动），运行时如报错按官方 quickstart 校准；案例为公开历史与模式。
