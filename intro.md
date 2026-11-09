# K8s for Senior Dev — 面向资深开发者的 Kubernetes 完整学习路径

> 定位：你已经写了十年 Java，懂 Docker、CI/CD、分布式系统，不需要再听"容器是什么"。
> 这份教程是一条 fast path：用你已有的工程直觉去映射 K8s 的设计，直奔资深开发者最容易踩的坑。
>
> 预计投入：精读 20-25 小时 + 动手 lab 15-20 小时（30 章完整版）。

## 读前自检

以下问题全部"是"，直接开始；有"否"，先补对应章节（括号内）：

- 我能说清 Docker 的 namespace/cgroup 分别隔离什么（第 2 章 2.1 有 5 分钟回顾）
- 我写过或维护过无状态服务的滚动发布（第 4 章）
- 我知道 CAP 定理、幂等、至少一次投递（第 10 章直接依赖）
- 我用命令行排过线上问题（ssh + grep log 级别即可）

## 全书结构（30 章）

**第一部分：架构判断（为什么是 K8s）**

- 第 1 章 为什么 K8s 赢了 — 一次架构史复盘，而不是技术赞美诗

**第二部分：核心对象速通（每章一张心智图）**

- 第 2 章 心智模型总装 — 控制面/数据面与声明式 API
- 第 3 章 Pod — 最小调度单元的真实语义
- 第 4 章 Deployment — 滚动发布的状态机
- 第 5 章 Service — 集群内的服务发现与负载均衡
- 第 6 章 Ingress 与 Gateway API — 七层入口
- 第 7 章 ConfigMap / Secret — 配置的分发与边界
- 第 8 章 存储 — PV / PVC / StorageClass 三层抽象

**第三部分：资深开发者最容易踩的 10 个坑（第 9-11 章，按主题聚簇）**

- 第 9 章 资源管理 — requests/limits/QoS/驱逐（坑 1-3）
- 第 10 章 优雅终止 — 探针/信号/PDB/滚动窗口（坑 4-7）
- 第 11 章 弹性伸缩 — HPA 抖动/VPA 重建/节点扩缩（坑 8-10）

**第四部分：实战线**

- 第 12 章 可观测性 — metrics / logs / tracing 三支柱落地
- 第 13 章 GPU 调度与 AI 应用部署 — 从 device plugin 到 vLLM
- 第 14 章 kind 实战 — 本地起集群、部署一个真实 AI 应用、全链路验证
- 第 15 章 排障手册 — kubectl 速查 + 20 个真实故障场景

**第五部分：运营商级主题（第 16-27 章）**

- 第 16 章 Gateway API 生产落地 — 分权模型/迁移/IngressNightmare
- 第 17 章 服务网格选型实战 — Sidecar/Ambient/eBPF 三路线与内存税
- 第 18 章 多集群与联邦 — 四个正当理由与 L1-L4 成本阶梯
- 第 19 章 GPU 调度深耕 — MIG/拓扑/gang 调度/DRA
- 第 20 章 安全加固 — 五层防线与加固体检 lab
- 第 21 章 PaC 成本治理 — OpenCost/右配/Spot/Karpenter 四杠杆
- 第 22 章 NetworkPolicy 与 CNI — 三定律与默认拒绝实操
- 第 23 章 Operator 与 CRD — kopf 40 行控制器与幂等性
- 第 24 章 GitOps 与渐进式交付 — ArgoCD/Rollouts/Secret 方案
- 第 25 章 etcd 与控制面 HA — 体检/备份恢复/故障指纹
- 第 26 章 大规模集群稳定性 — 五条物理定律与规模剖面
- 第 27 章 版本升级与灾备 — 升级清单/灾备重建计时

**第六部分：冲刺线**

- 第 28 章 公开事故复盘集 — 5 个可查证事件 + 10 个行业模式
- 第 29 章 毕业项目 — 生产级 AI 推理平台（9 项验收）
- 第 30 章 求职冲刺 — 面试地图 + 高频 20 题精写

## 约定

- 环境：macOS 或 Linux，Docker Desktop / OrbStack / Podman 均可；集群用 kind（第 14 章有完整安装步骤）。
- 版本基线：Kubernetes 1.30+。涉及版本差异的地方会显式标注（如 Gateway API 的 GA 状态、Sidecar 容器的正式版）。
- 每个 lab 都给出完整可复制命令，命令前标注预期耗时。
- 不确定/随环境而变的内容统一用 ⚠️ 标注。

## 建议节奏

1. 第 1 章精读（30 分钟）——先建立"为什么"，后面所有细节都有挂靠点。
2. 第 2-8 章每章：读 20 分钟 + lab 15 分钟，一口气过完对象模型。
3. 第 9-11 章是全书核心，慢读，每个坑都在自己集群里复现一遍。
4. 第 14 章是总实战，前面所有 lab 的产出在这里汇成一个完整应用。
5. 第 15 章当工具书用，先读"排障总法"，场景按需查。
6. 第 16-27 章按职业方向选读：AI/平台岗重点 16/19/21/24；安全岗 20/22/25；通用资深 26/27。
7. 第 29 章毕业项目作为 capstone，做完才算"完整课"闭环；第 30 章面试前两周开始背。

## 配套成品

- [landing.html](landing.html) — 课程介绍页（卖点/适合谁/试读）
- [index.html](index.html) — 30 章全课目录页（难度标注 + 一句话导读）
- [projects/](projects/) — 3 个 kind 集群真实可跑的实战项目（含 README + 部署/验收脚本）：
  1. [带 HPA 的 AI 推理服务](projects/p1-ai-inference-hpa/README.md)（压测扩缩 + restricted 基线，6 项验收）
  2. [GitOps 流水线](projects/p2-gitops-pipeline/README.md)（ArgoCD + 集群内 Gitea，selfHeal 演示）
  3. [多租户 Namespace 治理](projects/p3-multi-tenant-governance/README.md)（配额/网络隔离/RBAC/准入四层）
- [20-failures/](20-failures/) — 20 个故障卡片，与正文章节双向互链
