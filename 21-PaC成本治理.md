# 第 21 章 平台工程与成本治理（PaC）— K8s 账单的物理学

> PaC = Platform & Cost。云上 K8s 集群的账单里通常有 20-40% 是纯浪费（业界 FinOps 公开报告的常见区间），来源高度集中：超配的 requests、没人认领的孤儿负载、默认不用 Spot、没有自动缩容的夜间集群。本章把成本当工程指标治理，不是当会计问题。

## 21.1 开篇判断

先做三道算术题，不用工具，心算即可：

1. 你们集群 CPU 的 requests 总量 vs 实际 P95 使用量，比值是多少？>2 就有系统性超配。
2. 你们 GPU 节点夜里（无任务时）在跑吗？在跑，每夜烧掉一台 H100 的闲置成本。
3. 每个月有人看单位业务指标的成本吗（每千次请求成本/每 token 成本/每 DAU 成本）？没有，说明成本还没有进入工程反馈回路。

三题都答不上来，本章价值上限极高。

## 21.2 原理：成本治理的四个杠杆

**杠杆 1 — 可见性（前置条件）**：Kubernetes 成本可见性的事实标准是 OpenCost（前身 Kubecost 开源内核）：按 Pod/命名空间/标签分摊节点+PV+LB 成本。装完第一周不要做任何优化，只做"认领"：把无主成本（无标签/无 owner 的负载）归零。经验规律：认领阶段本身就能砍掉 5-10% 账单——因为一半的孤儿负载是离职的人留下的测试实例。

**杠杆 2 — 右配（requests/limits 校准）**：第 9 章讲了 QoS 机制，本章讲怎么定数。方法论：用 Prometheus 的 `container_memory_working_set_bytes` 与 `rate(container_cpu_usage_seconds_total)` 取 P95，requests = P95 × 1.2~1.5，limits 视类型（内存=接近 requests 防 OOM 放大；CPU 可不限或限在 2×requests 防失控）。VPA 的 Recommendation 模式可以先跑两周只出建议不应用。**超配的隐性代价**：requests 虚高 → 调度器认为节点满了 → 扩容 → 账单涨，但真实利用率没变——你在为"谎报"付费。

**杠杆 3 — 购买策略（Spot/RI/承诺折扣）**：无状态与可重试批处理负载上 Spot（抢占实例），价格通常是按需的 3-7 折（各云公开定价）。Spot 不是免费午餐：需要 PDB+优雅终止（第 10 章）+ 检查点重试。组合拳是标准打法：**基线流量用承诺折扣，弹性流量用 Spot，两者比例 = 流量曲线的基线/弹性分解**。节点缩容器（Cluster Autoscaler 或 Karpenter）负责把"缩容"真的执行掉——Karpenter 的差异化是直接管理 EC2/VM 实例而非 ASG，能按 Pod 需求即时选型（"这批 Pod 要 GPU+大内存，直接开一台 g6e"），启动速度快数分钟，是 2026 的主流选择。

**杠杆 4 — 调度行为（时段与打包）**：夜间/周末自动缩容 CI 集群与开发环境（副本数降到最低或集群停机）；bin-packing 优先（MostAllocated 策略）把负载塞满已有节点再开新节点——默认调度器的 LeastRequested 优先打分是"反打包"的，这个反直觉点面试常考。

## 21.3 实操 lab：给自己的集群装上成本眼睛 + 右配演练

```bash
# 1. 装 OpenCost（kind 集群，约 2 分钟）
helm repo add opencost https://opencost.github.io/opencost-helm-chart && helm repo update
helm install opencost opencost/opencost -n opencost --create-namespace \
  --set opencost.prometheus.external.enabled=false \
  --set opencost.ui.enabled=true
kubectl -n opencost rollout status deploy/opencost --timeout=180s
kubectl -n opencost port-forward deploy/opencost 9090:9090 &
sleep 5
# API 直接问：过去一天每个 namespace 的成本（kind 单机数字无实际意义，看的是机制）
curl -s "http://localhost:9090/allocation/compute?window=1d&aggregate=namespace" | jq '.data[0] | to_entries[:5]'

# 2. 右配演练：制造一个"谎报"负载
kubectl -n ai-lab create deployment hog --image=busybox:1.36 -- sh -c 'while true; do sleep 3600; done'
kubectl -n ai-lab set resources deploy/hog --requests=cpu=4,memory=8Gi --limits=cpu=4,memory=8Gi
# 看 OpenCost 眼里它的"成本"立刻变贵（requests 驱动分摊）：
curl -s "http://localhost:9090/allocation/compute?window=10m&aggregate=namespace" | jq '.data[0]["ai-lab"].cpuCoreHours'

# 3. 用真实用量揭穿谎言（P95 视角，PromQL）
kubectl -n ai-lab run p95 --image=busybox:1.36 --restart=Never -- sh -c 'echo 在生产里用 Prometheus 查 working_set P95; sleep 5'
# 生产 PromQL（此处给标准查询，备忘）：
#   quantile_over_time(0.95, container_memory_working_set_bytes{pod="hog-xxx"}[1d])
kubectl -n ai-lab delete deploy hog

# 4. 打包策略对比（反直觉点演示）：起两个节点池逻辑（lab 用 mostAllocated 描述即可）
# 生产改法备忘：
#   kube-scheduler --profile ... 或 KubeSchedulerConfiguration profiles 的
#   plugins.score.pluginConfig: [{name: NodeResourcesFit, args: {scoringStrategy: {type: MostAllocated}}}]
kubectl get nodes -o custom-columns='NAME:.metadata.name,CPU-REQ:.status.allocatable.cpu'

# 5. 夜间缩容的雏形（CronJob 缩开发环境，生产标配模式）
cat <<'EOF' | kubectl -n ai-lab create -f -
apiVersion: batch/v1
kind: CronJob
metadata: { name: night-shrink }
spec:
  schedule: "0 19 * * 1-5"   # 工作日 19 点
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: default   # 生产: 专用 SA 只授权 patch deployments
          restartPolicy: OnFailure
          containers:
          - name: kubectl
            image: bitnami/kubectl:1.30
            command: ["sh","-c","kubectl -n ai-lab scale deploy --all --replicas=1"]
EOF
kubectl -n ai-lab get cronjob night-shrink
```

预期总耗时 8-12 分钟。OpenCost 在 kind 上数字无意义，但分摊机制、API、标签认领流程和生产完全一致——lab 的目的是把这套流程跑顺。

## 21.4 生产案例：公开复盘与事故模式

案例一（行业通病，模式，量级来自公开 FinOps 报告）：requests 谎报税。企业 K8s 账单中 30%± 浪费是 FinOps 基金会公开报告的常见区间，其中超配 requests 是最大单项。一个可复述的典型算术：100 节点 ×40 vCPU，requests 利用率 2 倍虚高 → 约 1/3 节点是为空气开的 → 年成本七位数人民币量级（按主流云价格心算）。治理次序永远是：先可见性、再认领、再右配、最后才是买折扣——顺序错了（先买 RI）会把浪费锁定。

案例二（公开技术模式）：Spot 抢占导致的雪崩。无状态服务上了 Spot 但没配 PDB，云厂商一波批量回收时副本数跌破可用线，服务雪崩。公开的最佳实践（AWS/Google Spot 官方文档都写明）：Spot 节点必须 `maxUnavailable` 保守的 PDB + 拓扑打散 + 优雅终止处理 2 分钟告警窗口。**Spot 的工程前提是第 10 章优雅终止做扎实**——这也是课程章节互相咬合的例子。

案例三（公开模式）：Karpenter vs Cluster Autoscaler 的迁移收益。多个公开工程博客（如各 AI 公司的推理平台复盘）给出的模式：CA 通过 ASG 间接管理节点，选型受 ASG 启动延迟约束；Karpenter 直接管实例，按 Pod 现需选型（含 GPU 型号），冷启动从 5-10 分钟降到 1-3 分钟。对弹性敏感的 AI 推理平台，这个差值直接转化为请求延迟或成本。注意 Karpenter 是云绑定（AWS 版最成熟，Azure/GCP 各有分支），多云团队要按云评估。

## 21.5 本章面试题

1. 为什么超配 requests 会让账单变贵？（调度器按谎报容量扩容，为空气付费）
2. 右配的方法论数据是什么？（P95 用量 ×1.2-1.5，VPA Recommendation 先观察后应用）
3. Spot 上生产的三个前提？（PDB+优雅终止+检查点重试，容忍 2 分钟回收告警）
4. Karpenter 相比 Cluster Autoscaler 的本质差异？（直接管实例/按需即时选型 vs 通过 ASG 间接管理）
5. 默认调度器为什么"反成本"？怎么改？（LeastRequested 分散打分反打包；MostAllocated 策略切换）
6. 成本治理的正确次序？（可见性→认领→右配→购买策略，倒序会锁死浪费）

## 21.6 自测清单

- [ ] 能说出自己集群 requests/实际用量的比值数量级
- [ ] lab 里跑通了 OpenCost 的 namespace 分摊 API
- [ ] 会写右配的 PromQL（P95 内存/CPU）
- [ ] 能复述 Spot 雪崩事故链与三个前提
- [ ] 能给管理层画一张"四杠杆×预期收益"的治理路线图

> 调研粮备注：量级数据来自公开 FinOps 报告与厂商公开文档；无本公司/内部账单一手数据，落地时以自己集群的 OpenCost 数据为准。


## 相关故障卡片（动手复现版）

本章知识点对应的真实故障，可在 kind 集群亲手制造并修复：

- [15 | ResourceQuota：第三副本永远起不来](20-failures/15-ResourceQuota-副本卡在配额.md)
