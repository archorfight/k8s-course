# 第 19 章 GPU 调度深耕 — MIG、拓扑与动态资源分配

> 第 13 章解决了"GPU 怎么被 K8s 看见和分配"（device plugin + 假 GPU lab）。本章进入运营商级问题：一块 H100 三万多美金，平均利用率行业公开数据常年在 30-50% 徘徊——GPU 集群调度的每一个百分点都是真金白银。

## 19.1 开篇判断

三个问题定位你的 GPU 集群处于哪一代：

1. 你是否把整卡分配给小模型推理（占用率 20% 的服务独占一张 H100）？→ 粒度浪费。
2. 你是否知道两个分布式训练任务因为各占半张卡的带宽而互相拖慢？→ 拓扑盲区。
3. 你是否还在用 `nvidia.com/gpu: 1` 的整数语义做一切调度？→ 那你在 2020 年的模型里。

三个"是"意味着你的 GPU 账单里有 30% 以上是可省的。本章给你三个工具：MIG（空间切分）、拓扑感知调度（NVLink/PCIe 拓扑）、DRA（动态资源分配，1.26+ Alpha→1.32+ 趋于成熟的方向）。

## 19.2 原理

**MIG（Multi-Instance GPU）**：A100/H100 硬件级把一张卡切成最多 7 个隔离实例（如 1g.10gb / 2g.20gb / 3g.40gb），每个实例有独立的显存、SM 与缓存带宽，故障与性能互不干扰。K8s 侧由 GPU Operator 管理 MIG 配置，device plugin 以 `nvidia.com/mig-1g.10gb` 这类资源名暴露。与显存软共享（时间片）相比：MIG 是硬隔离（推理毛刺互不影响），时间片是软共享（利用率高但噪声大）。选型口诀：**延迟敏感的推理服务用 MIG；吞吐型批任务用时间片；训练用整卡**。

**拓扑感知调度**：一台 8 卡机里，卡与卡之间可能是 NVLink（GPU 间 900GB/s）、NVSwitch 全互联或 PCIe（差一个数量级）。分布式训练任务的所有卡若被调度到"远端"互联上，allreduce 时间可能翻几倍。K8s Scheduler 的默认打分不管这个——需要 GPU Operator 暴露拓扑资源、或 Volcano/Kueue 等批调度器做 gang scheduling（一组 Pod 要么全调度成功要么全等待，避免 8 卡任务占了 7 卡死锁）。**没上 gang scheduling 的训练集群必然出现死锁**：两个 8 卡任务各抢到 4 卡，永远等不齐。

**DRA（Dynamic Resource Allocation）**：传统 device plugin 的三大缺陷——整数粒度、不感知拓扑、声明式整合差。DRA 把"资源请求"抽象成 ResourceClaim，驱动（如 NVIDIA 的 DRA driver）可以按结构化参数（"我要 4 张卡，两两 NVLink 直连"）分配并返回拓扑约束。它还支持 CDCD（可声明式 CDI 设备）让容器运行时拿到精确设备句柄。这是 GPU 调度的未来形态，2026 基线：新集群规划直接纳入，存量集群关注 driver 成熟度。

**顺带一句 Kueue**：如果做 AI 平台，Kueue（K8s 原生作业队列/配额管理）+ Volcano 是当前主流组合——把集群的 GPU 配额按团队划分、排队、抢占，语义远比"人人 kubectl apply 抢卡"健康。

## 19.3 实操 lab：假 GPU 上模拟 MIG 粒度与 gang 调度问题

延续第 13 章的假 GPU 思路（不需要真卡），先看粒度，再看死锁。

```bash
# 前提：第 14 章 kind 集群 + 第 13 章的 fake-gpu device plugin 还在
kubectl get nodes -o custom-columns='NAME:.metadata.name,GPU:.status.capacity.nvidia\.com/gpu'

# 1. 粒度问题复现：一个只配 4Gi 显存需求的推理服务申请了整卡
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata: { name: small-llm, namespace: ai-lab }
spec:
  replicas: 1
  selector: { matchLabels: { app: small-llm } }
  template:
    metadata: { labels: { app: small-llm } }
    spec:
      containers:
      - name: srv
        image: busybox:1.36
        command: ["sh","-c","echo 用 20% 算力但独占一整卡; sleep 3600"]
        resources:
          limits: { nvidia.com/gpu: 1, memory: 4Gi }
EOF
# 观察：整个节点的 GPU 账本被这个"小服务"吃掉一格
kubectl describe node | grep -A2 "nvidia.com/gpu"

# 2. gang 死锁复现（核心实验）：两个"8卡"任务挤一个 8 卡节点
# 先删掉 small-llm 释放账本
kubectl -n ai-lab delete deploy small-llm
for j in job1 job2; do
cat <<EOF | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata: { name: $j, namespace: ai-lab }
spec:
  completions: 8
  parallelism: 8
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: trainer
        image: busybox:1.36
        command: ["sh","-c","sleep 60"]
        resources: { limits: { nvidia.com/gpu: 1 } }
EOF
done
kubectl -n ai-lab get pods | grep -c Running   # 观察：两个 Job 各跑了几个？
# 预期：8 张卡被两个 Job 以某种混合方式瓜分（如 5+3），谁也完不成不了 8 并行，
# 或者一个跑完另一个慢慢补——总之没有"整组原子性"。
# 这就是没有 gang scheduling 的世界。清理：
kubectl -n ai-lab delete job --all

# 3. 用 PodGroups 思维修正（Volcano 未装时用 completion 内并行+优先级近似，
#    生产用 Volcano/Kueue；这里演示"原子性"语义为什么重要）
# 记录现象即可，第 24 章后会补 Volcano lab（见缺粮备注）
```

预期总耗时 8-10 分钟。第 2 步的观察就是本章的"灵魂实验"：**K8s 原生 Job 没有跨 Pod 原子性，训练集群必须上批调度器**。

## 19.4 生产案例：公开复盘与事故模式

案例一（公开数据模式）：GPU 利用率洼地。多家云厂商与 NVIDIA 公开材料反复引用同一量级：企业 GPU 集群平均利用率显著低于 CPU 集群，闲置源于"整卡分配+小负载"。微软等公开发表的 GPU 调度论文（如 MLForSys 方向的分组打包调度研究）给出的收益量级是同硬件吞吐翻倍。落到你的汇报：**先上利用率监控（DCGM exporter + Grafana），数据说话再谈切分**。

案例二（公开事故模式）：分布式训练掉速 5 倍。社区反复出现的模式：训练任务各 GPU 落在 NUMA/PCIe 远端，NCCL allreduce 慢数倍，大家以为是网络问题排查一整天。诊断命令是标准化的：`nvidia-smi topo -m` 看拓扑、`nccl-tests` 的 all_reduce busbw 做基线比对。预防手段就是拓扑感知调度与节点内亲和（每 NUMA 一个 Pod）。

案例三（公开事件，可查证）：device plugin 的 `KUBE_PLUGINS` 注册制长期存在的坑——kubelet 重启后 plugin 重连失败导致 GPU "消失"，社区 issue 众多，1.26 后 scheduler 的 DeviceClass/DRA 也是为根治这一类问题。给你的运维清单加一条：**GPU 节点 kubelet/plugin 健康监控必须存在**，症状是 node capacity 里 GPU 归零。

## 19.5 本章面试题

1. MIG、时间片、整卡各适合什么负载？为什么？（延迟敏感推理=MIG 硬隔离；吞吐批处理=时间片；训练=整卡+拓扑）
2. 什么是 gang scheduling？没有它会出什么事故？（跨 Pod 原子性缺失→训练任务互卡死锁）
3. 为什么训练任务慢 5 倍要先看拓扑而不是网络？（NVLink/PCIe/NUMA 落点错误是高频根因，nvidia-smi topo -m + nccl-tests 定位）
4. DRA 相比 device plugin 解决什么？（分数粒度、拓扑声明、声明式 API 与预热/弹性）
5. GPU 集群上线第一步做什么？（利用率与账本监控：DCGM + Prometheus，没有数据的优化都是玄学）

## 19.6 自测清单

- [ ] 能算一笔"整卡分配给小服务"的浪费账
- [ ] 能解释 MIG 的硬隔离与时间片的软共享差异
- [ ] lab 中亲眼看到无 gang 调度时 Job 瓜分 GPU 的现象
- [ ] 会用 nvidia-smi topo -m 与 nccl-tests 排查训练掉速
- [ ] 能讲清 DRA 的三个增量与落地时间表判断

> 调研粮备注：Volcano/Kueue 的实操 lab 未在本章展开（依赖第 24 章环境），标注为待补；案例均为公开可查证数据/模式。
