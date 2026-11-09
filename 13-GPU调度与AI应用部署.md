# 第 13 章 GPU 调度与 AI 应用部署 — 从 device plugin 到 vLLM

> 心智图：
> ```
#   GPU不是"一种资源", 是一块带驱动+运行时的PCIe设备:
#
#   节点侧: NVIDIA驱动(宿主) + nvidia-container-toolkit + device plugin Pod(DaemonSet)
#           → 把GPU以 extended resource "nvidia.com/gpu: 1" 注册给kubelet
#   调度侧: requests.nvidia.com/gpu: 1 → scheduler把Pod绑到有GPU的Node
#           → kubelet把设备(/dev/nvidia0 + CUDA上下文)透传进容器
#   隔离粒度: 整卡为粒度! (MIG可切分; 时间片/显存超卖需要第三方: volcano/hami)
#   生态: GPU Operator(Helm一把装全套) + taint/toleration(GPU节点专用化)
#         + DCGM exporter(Prometheus看GPU利用率/显存/温度)
> ```

## 开篇判断

1) GPU 在 K8s 里是什么类型的资源、谁记账？2) 我的推理服务显存怎么预算的（模型+KV cache+框架开销）？3) 没有 GPU 的机器能不能验证 GPU 部署清单？第三问答"不能"，本章 lab 会改观。
## 13.1 GPU 调度的机制层：extended resource

K8s 原生只认识 cpu/memory/ephemeral-storage，GPU 是通过 **extended resource** 机制挂进来的：device plugin（一个 DaemonSet）向 kubelet 上报 `nvidia.com/gpu: N`，kubelet 再汇报给 apiserver，scheduler 就能像调度 CPU 一样调度 GPU——但语义有硬差异，全是坑点：

1. **只能 request 整数张卡，不能 limit**（`limits` 里的 GPU 数字会被忽略语义上等于 request）。一卡一 Pod，利用率低是常态——这正是 Fractional GPU（HAMI、Volcano）存在的理由，⚠️ 但它们是侵入式补丁，社区分歧中，生产采用前先评估驱动版本兼容。
2. **request 即独占**：没有"超卖"，request 了 GPU 的 Pod 独占该卡（除非 MIG）。**MIG**（A100/H100 硬件切分，如 1g.10gb）让一卡切成最多 7 个实例，是官方支持的"切卡"路径——推理小模型的性价比之王，需要节点和驱动配合（`nvidia.com/mig-1g.10gb: 1`）。
3. **显存不受 K8s 管**：`limits.memory` 是主内存，GPU 显存（HBM）没有 cgroup 式限制——一个 Pod 可以 OOM 掉整张卡的显存影响同卡邻居（MIG 下才隔离）。所以"GPU 应用 OOM"要看 CUDA 的 OOM 报错，不是 exit 137。

## 13.2 节点专用化：taint / toleration / affinity 三件套

GPU 节点贵，绝不能让无 GPU 需求的 Pod 偷懒调度上去（还有把 GPU 节点 taint 后普通 Pod Pending 的反向坑）。标准配置：

```yaml
# 节点打污点: 没带toleration的Pod一律不上GPU节点 (kubectl taint node gpu1 nvidia.com/gpu=true:NoSchedule)
# GPU应用侧:
spec:
  tolerations:
  - { key: nvidia.com/gpu, operator: Exists, effect: NoSchedule }
  nodeSelector: { nvidia.com/gpu.present: "true" }   # 或nodeSelector直接用标签
  containers:
  - name: vllm
    resources:
      limits: { nvidia.com/gpu: 1, cpu: "8", memory: 32Gi }
```

三件套分工：**taint 是节点拒绝别人的门禁，toleration 是 Pod 的通行证，affinity/nodeSelector 是 Pod 主动挑选**。只用 affinity 不用 taint = GPU 节点会被别的 Pod 偷偷占满（你的推理 Pod 反而上不去）；只用 taint 不用 affinity = 万一通行证发多了照样挤。**两个都上**。

## 13.3 部署一个生产级推理服务：vLLM 清单精讲

vLLM 是 LLM 推理的事实标准引擎，它的清单几乎用到全书所有章节：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: vllm-qwen }
spec:
  replicas: 1                              # GPU贵, 每副本1卡, 横向扩靠HPA+队列指标
  strategy:
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }   # ★第4章: GPU滚动不能掉容量
  selector: { matchLabels: { app: vllm } }
  template:
    metadata: { labels: { app: vllm } }
    spec:
      tolerations:
      - { key: nvidia.com/gpu, operator: Exists, effect: NoSchedule }
      nodeSelector: { "nvidia.com/gpu.product": "NVIDIA-A10" }  # 按卡型调度(不同卡型价格/显存差大)
      terminationGracePeriodSeconds: 120    # ★第10章: 长推理请求+排队, 终止窗口必须够
      securityContext: { runAsNonRoot: true }
      containers:
      - name: vllm
        image: vllm/vllm-openai:v0.6.4-post1        # ★tag不可变(第3章)
        args:
        - --model=Qwen/Qwen2.5-7B-Instruct
        - --gpu-memory-utilization=0.92              # 显存预算(默认0.9), 留padding给激活
        - --max-model-len=8192
        ports: [ { containerPort: 8000 } ]
        readinessProbe:                              # /health是引擎级健康(模型加载完才算好)
          httpGet: { path: /health, port: 8000 }
          periodSeconds: 10
        startupProbe:                                # ★第10章: 模型加载可达数分钟
          httpGet: { path: /health, port: 8000 }
          periodSeconds: 10
          failureThreshold: 60                       # 最多等10分钟
        lifecycle:
          preStop:
            httpGet: { path: /shutdown, port: 8000 }  # 若引擎支持drain端点;否则sleep
        resources:
          limits: { nvidia.com/gpu: 1, cpu: "8", memory: 40Gi }
        volumeMounts: [ { name: dshm, mountPath: /dev/shm } ]   # ★多进程数据加载需要大shm
      volumes:
      - name: dshm
        emptyDir: { medium: Memory, sizeLimit: "2Gi" }          # 第8章: tmpfs emptyDir
---
apiVersion: v1
kind: Service
metadata: { name: vllm, labels: { app: vllm } }
spec:
  selector: { app: vllm }
  ports: [ { port: 8000, name: http } ]    # 长连接SSE → 注意L4均衡+客户端keepalive(第5章)
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: vllm }
spec:
  minAvailable: 1                           # ★第10章: 单副本也别裸奔(多副本再放宽)
  selector: { matchLabels: { app: vllm } }
```

四个 AI 特有的工程点：

- **模型在哪**：① 镜像里打包（启动快，镜像 20GB+，第 14 章的痛点）；② PVC/RWX 网络卷挂载（镜像小，多副本共享，冷启动慢）；③ vLLM 支持 s3 直接拉。选型：副本多+模型固定 → RWX 或镜像内嵌；模型频繁换 → 对象存储。
- **SSE/流式响应与代理链**：OpenAI 兼容 API 的 stream=true 走 SSE，Ingress/LB 的 `proxy-read-timeout`、buffering 要关（nginx 注解 `proxy-buffering: "off"`），否则流式输出被缓冲成卡顿。
- **HPA 用什么指标**：GPU utilization（DCGM exporter 的 `DCGM_FI_DEV_GPU_UTIL`）或 vLLM 的 `num_requests_waiting`（排队深度）比 CPU 有意义得多——KEDA 的 prometheus scaler 直接吃这个指标。
- **批处理与在线混部**：训练 Job（第 4 章）用 `priorityClass` 低优先级 + 在线服务高优先级，同一 GPU 池错峰——但整卡粒度下"混部"其实是分时段，真混部要 MIG 或第三方分卡方案。

## 13.4 GPU Operator 与可观测

裸装路径（驱动在宿主、container-toolkit、device plugin、DCGM exporter、gpu-feature-discovery 一个个 DaemonSet）适合理解原理；生产路径是 **GPU Operator**（Helm 一装，包含以上全部并管理驱动容器化——甚至驱动也进容器，节点复用灵活性拉满）。监控：DCGM exporter 暴露 `DCGM_FI_DEV_GPU_UTIL`（利用率）、`DCGM_FI_DEV_FB_USED`（显存）、`DCGM_FI_DEV_GPU_TEMP`，接第 12 章的 Prometheus 栈；告警必配"显存 >95%"和"ECC 错误"。

## Lab 13：无 GPU 机器上的 GPU 语义模拟（CPU 跑通全流程）

```bash
# 原理: extended resource不挑食, 我们手工注册一个假的"GPU"资源, 完整走一遍调度语义
# (本地kind节点上CPU跑vLLM不现实, 但调度/亲和/资源账本行为100%一致)

# 1. 给worker节点"安装"8块假GPU (真实世界=device plugin自动做)
kubectl patch node k8s-lab-worker --subresource=status -p \
  '{"status":{"capacity":{"fake.example.com/gpu":"8"}}}'
kubectl get node k8s-lab-worker -o jsonpath='{.status.capacity}' | python3 -m json.tool

# 2. 部署一个"GPU"应用 (模拟推理Pod的完整资源/调度语义)
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata: { name: fake-gpu-app }
spec:
  replicas: 3
  selector: { matchLabels: { app: fgpu } }
  template:
    metadata: { labels: { app: fgpu } }
    spec:
      nodeSelector: { kubernetes.io/hostname: k8s-lab-worker }
      containers:
      - name: app
        image: hashicorp/http-echo:1.0
        args: ["-text=gpu-slot-used","-listen=:80"]
        resources:
          limits: { fake.example.com/gpu: 1 }    # ★extended resource: 只写limits即可
EOF
kubectl get pods -l app=fgpu -o wide   # 3个Pod全部落在worker

# 3. 扩到10副本 → 第9个起Pending (节点只有8块)
kubectl scale deploy fake-gpu-app --replicas=10
kubectl get pods -l app=fgpu | grep -c Running   # =8
kubectl get events --sort-by=.lastTimestamp | grep -m2 "Insufficient fake.example.com/gpu"
# → 0/2 nodes are available: 1 Insufficient fake.example.com/gpu ★GPU不足的标准报错, 一字不差
# (⚠️ 原写法 kubectl describe pod -l ... | grep Events 在未调度Pod上看不到Events段, 1.37实测为空)

# 4. 看资源账本 (调度器如何记账)
kubectl describe node k8s-lab-worker | sed -n '/Allocated resources/,/Events/p' | grep -E "gpu|Name"

# 5. 清理
kubectl delete deploy fake-gpu-app
kubectl patch node k8s-lab-worker --subresource=status -p '{"status":{"capacity":{"fake.example.com/gpu":"0"}}}'
```

验证点：①extended resource 的 request/记账/Pending 语义与 CPU 完全同构；②"Insufficient nvidia.com/gpu" 就是云上 GPU Pod 起不来的真实报错——下次在真集群看到它，你知道检查链条：device plugin 活没活 → 节点 `nvidia.com/gpu` capacity 有没有 → taint/toleration 配没配。

## 生产案例：GPU 账本消失与利用率洼地（公开模式+本课程实测）

模式一（社区高频 issue）：kubelet/device plugin 重连失败，节点 GPU capacity 归零，任务全部 Pending——GPU 节点的 plugin 健康监控是必备项。模式二（公开数据）：企业 GPU 平均利用率长期 30-50%，整卡配小负载是最大浪费——第 19 章 MIG/DRA/gang 的展开。本课程实测细节：未调度 Pod 的 describe 里 Events 可能为空（1.37），查 FailedScheduling 要用 `kubectl get events | grep Insufficient`。

## 本章面试题

1. extended resource 的机制？谁记账？（scheduler 只看账本，device plugin 负责上账与挂设备）
2. taint/toleration/affinity 在 GPU 集群的三件套用法？
3. vLLM 生产清单的关键项？（显存预算、tensor-parallel 与调度约束、健康探针）
4. 无 GPU 怎么验证 GPU 部署语义？（假 GPU 账本法——本课程 lab 的思路）

## 自测清单

- [ ] lab 里跑通了 8 卡上限+第 9 个 Pending+账本查询
- [ ] 会查 Insufficient nvidia.com/gpu 的事件
- [ ] 能给自己团队的 GPU 服务写资源申请清单
