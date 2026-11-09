# 第 14 章 kind 实战 — 本地起集群、部署一个真实 AI 应用、全链路验证

> 心智图：
> ```
#   本章是全书实战线的汇合点, 一条命令链跑完:
#
#   kind集群(2节点) → metrics-server → ingress-nginx → cert-manager(可选)
#     → 部署"AI应用": embeddings服务(小模型, CPU可跑) + 前端
#     → Ingress域名路由 → HPA压力验证 → 滚动发布零中断验证
#   技术选型: 用CPU可跑的真模型(ggerganov/ggml 或 all-MiniLM) 而不是nginx假扮——
#   慢启动/内存limit/长请求的"AI味"问题才会真实出现
> ```

## 开篇判断

1) 前面各章的 lab 我做了几成（≥60% 再开始本章）？2) 集群内服务互访的完整 URL 我写得出吗？3) 压测为什么不能一次性 burst？本章是总装实战，前两问答不利索会卡在验证环节。
## 14.1 环境与集群基线

```bash
# 依赖检查: Docker/OrbStack运行中 + kind + kubectl + helm (第12章lab已装helm)
docker version --format '{{.Server.Version}}' && kind version && kubectl version --client --short 2>/dev/null || kubectl version --client

# 生产化集群配置 (含ingress端口映射/标签/资源)
cat <<'EOF' > ~/k8s-lab-cluster.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: k8s-lab
nodes:
- role: control-plane
  kubeadmConfigPatches:
  - |
    kind: InitConfiguration
    nodeRegistration:
      kubeletExtraArgs: { node-labels: "ingress-ready=true" }
  extraPortMappings:
  - { containerPort: 80,  hostPort: 80,  protocol: TCP }   # ingress http
  - { containerPort: 443, hostPort: 443, protocol: TCP }   # ingress https
- role: worker
  extraPortMappings: []
EOF
kind delete cluster --name k8s-lab 2>/dev/null
kind create cluster --config ~/k8s-lab-cluster.yaml     # 约2-4分钟
kubectl get nodes -o wide    # 2节点 Ready
```

基础设施三件套（前面章节的 lab 已做过，这里收敛成脚本，可重复执行）：

```bash
# metrics-server (⚠️ 用release地址, 原v0.7.2/manifest/base.yaml已404; args必须补--cert-dir=/tmp, 否则只读根文件系统上自签证书崩溃)
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl patch deployment metrics-server -n kube-system \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"metrics-server","args":["--kubelet-insecure-tls","--cert-dir=/tmp","--secure-port=10250"]}]}}}}'
# ingress-nginx
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=ready pod \
  -l app.kubernetes.io/component=controller --timeout=300s
kubectl wait --for=condition=available deploy/metrics-server -n kube-system --timeout=120s
echo BASE-READY
```

## 14.2 应用设计：最小但真实的 AI 服务

架构（刻意覆盖全书知识点）：

```
                     ai-lab.local (hosts→127.0.0.1)
                            │
                     Ingress(nginx)  ── /      → frontend (静态展示)
                                       /embed  → embed-svc (ONNX MiniLM, CPU推理, ~1s/req)
                                                ├ StartupProbe长(模型加载)
                                                ├ HPA(cpu 60%, 1→4)
                                                └ PDB maxUnavailable 1
```

镜像：`ghcr.io/...` 或自构建——**为了"可复制"，下面用多阶段 Dockerfile 自构建并 kind load 进集群**（避开拉墙外镜像的网络差异；⚠️ 如果本机拉取 HuggingFace 模型困难，all-MiniLM-L6-v2 也可从镜像源 hf-mirror.com 下载，Dockerfile 里已参数化）。

```dockerfile
# Dockerfile.embed  (python服务: 加载MiniLM做文本向量化)
FROM python:3.11-slim AS base
# ⚠️ HF_ENDPOINT已参数化: 新版 huggingface_hub 对 hf-mirror 的响应头校验不过会报
# "Distant resource does not seem to be on huggingface.co"; 能直连时用官方源构建:
#   docker build --build-arg HF_ENDPOINT=https://huggingface.co -f Dockerfile.embed -t embed-svc:v1 .
ARG HF_ENDPOINT=https://hf-mirror.com
ENV HF_ENDPOINT=${HF_ENDPOINT} PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
RUN pip install --no-cache-dir fastapi uvicorn sentence-transformers==3.0.1
RUN python -c "from sentence_transformers import SentenceTransformer as M; M('sentence-transformers/all-MiniLM-L6-v2')"
COPY app.py /
EXPOSE 8000
CMD ["uvicorn","app:app","--host","0.0.0.0","--port","8000"]
```

```python
# app.py
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import time, os
app = FastAPI()
_model = None
def get_model():
    global _model
    if _model is None: _model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    return _model
class Text(BaseModel): text: str
@app.get("/health")
def health(): return {"model_loaded": _model is not None, "pid": os.getpid()}
@app.post("/embed")
def embed(t: Text):
    v = get_model().encode([t.text])[0].tolist()
    return {"dim": len(v), "vec_head": v[:5], "took_s": round(time.time(), 3)}
```

构建与加载（CPU 机器全程可跑，模型仅 ~90MB）：

```bash
docker build -f Dockerfile.embed -t embed-svc:v1 .          # 约3-8分钟(首次拉模型)
kind load docker-image embed-svc:v1 --name k8s-lab           # 免registry直塞节点
```

## 14.3 完整部署清单（全书知识的物理形态）

```yaml
# k8s-lab-app.yaml — 每个字段都对应前文某章, 注释即索引
apiVersion: v1
kind: Namespace
metadata: { name: ai-lab }
---
apiVersion: v1
kind: ConfigMap                       # 第7章: 环境无关配置
metadata: { name: embed-cfg, namespace: ai-lab }
data:
  LOG_LEVEL: "INFO"
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: embed-svc, namespace: ai-lab }
spec:
  replicas: 1
  strategy:                                     # 第4章: 先加后减
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
  minReadySeconds: 10                           # 第4章: 防假就绪
  selector: { matchLabels: { app: embed-svc } }
  template:
    metadata: { labels: { app: embed-svc } }
    spec:
      terminationGracePeriodSeconds: 60         # 第10章: 推理请求耗时
      containers:
      - name: app
        image: embed-svc:v1
        envFrom: [ { configMapRef: { name: embed-cfg } } ]
        ports: [ { containerPort: 8000 } ]
        resources:                              # 第9章: requests校准过的值
          requests: { cpu: 300m, memory: 700Mi }
          limits:   { memory: 1Gi }             # 模型+torch ~600MB, 留余量; 不设cpu limit
        startupProbe:                           # 第10章: 模型加载慢
          httpGet: { path: /health, port: 8000 }
          periodSeconds: 5
          failureThreshold: 36                  # 最多3分钟
        readinessProbe:
          httpGet: { path: /health, port: 8000 }
          periodSeconds: 5
        livenessProbe:                          # 第10章: 轻量, 不查下游
          httpGet: { path: /health, port: 8000 }
          periodSeconds: 10
        lifecycle:
          preStop: { exec: { command: ["sleep","5"] } }   # 第10章: 摘流量缓冲
---
apiVersion: v1
kind: Service
metadata: { name: embed-svc, namespace: ai-lab }
spec:
  selector: { app: embed-svc }
  ports: [ { port: 8000 } ]
---
apiVersion: networking.k8s.io/v1
kind: Ingress                                    # 第6章
metadata:
  { name: ai-lab, namespace: ai-lab }
spec:
  ingressClassName: nginx
  rules:
  - host: ai-lab.local
    http:
      paths:
      - { path: /embed, pathType: Prefix,
          backend: { service: { name: embed-svc, port: { number: 8000 } } } }
---
apiVersion: autoscaling/v2                       # 第11章
kind: HorizontalPodAutoscaler
metadata: { name: embed-svc, namespace: ai-lab }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: embed-svc }
  minReplicas: 1
  maxReplicas: 4
  metrics:
  - type: Resource
    resource: { name: cpu, target: { type: Utilization, averageUtilization: 60 } }
---
apiVersion: policy/v1                            # 第10章
kind: PodDisruptionBudget
metadata: { name: embed-svc, namespace: ai-lab }
spec:
  maxUnavailable: 1
  selector: { matchLabels: { app: embed-svc } }
```

```bash
kubectl apply -f k8s-lab-app.yaml
kubectl rollout status deploy/embed-svc -n ai-lab --timeout=300s
echo "127.0.0.1 ai-lab.local" | sudo tee -a /etc/hosts
curl -s -X POST http://ai-lab.local/embed -H 'Content-Type: application/json' -d '{"text":"kubernetes for senior devs"}'
# → {"dim":384,"vec_head":[...],"took_s":...}   ★全链路通: ingress→svc→pod→模型
# (不想动 /etc/hosts 时等价写法: curl -H 'Host: ai-lab.local' http://127.0.0.1/embed ...)
```

## 14.4 全链路验证三连（把 9-11 章的坑逐一踩平）

```bash
# 验证A: HPA真的会扩 (持续压测~2分钟; 集群内访问Service必须带端口8000且用FQDN:
#  ⚠️ 原写法 http://embed-svc.ai-lab.svc/embed 双重踩坑——
#  a) 不带.cluster.local后缀会被CoreDNS转发到上游DNS拿到野IP直接黑洞;
#  b) Service端口是8000, 省略端口会打去80。实测两条都中招, 压测静默失败、HPA不动)
kubectl run load --rm -it --restart=Never --image=curlimages/curl:8.8.0 -- \
  sh -c 'for w in $(seq 1 8); do (i=0; while [ $i -lt 400 ]; do i=$((i+1)); curl -s -m 10 -X POST http://embed-svc.ai-lab.svc.cluster.local:8000/embed \
  -H "Content-Type: application/json" -d "{\"text\":\"load $w-$i\"}" >/dev/null; done) & done; wait' &
sleep 40 && kubectl get hpa -n ai-lab           # REPLICAS 应从1→2+ (M系列芯片单次推理仅~5ms, 必须并发持续压才有信号)
kubectl get pods -n ai-lab

# 验证B: 滚动发布零中断 (v2只改个环境变量, 流量不丢)
kubectl run watcher --restart=Never --image=curlimages/curl:8.8.0 -- \
  sh -c 'ok=0;fail=0;for i in $(seq 1 300); do curl -s --max-time 5 -X POST http://embed-svc.ai-lab.svc.cluster.local:8000/embed -H "Content-Type: application/json" -d "{\"text\":\"x\"}" >/dev/null && ok=$((ok+1)) || fail=$((fail+1)); echo ok=$ok fail=$fail; done' &
kubectl set env deploy/embed-svc -n ai-lab RELEASE=v2
kubectl rollout status deploy/embed-svc -n ai-lab
kubectl logs -l run=watcher --tail=1            # fail应为0或个位数 (graceful+preStop生效)

# 验证C: 排障链路完整性
kubectl top pod -n ai-lab                       # metrics: 每Pod真实用量
kubectl get events -n ai-lab --sort-by=.lastTimestamp | tail -10   # 滚动的事件流
```

## 14.5 收尾与断点续跑

```bash
# 保留现场慢慢玩: kind cluster留在, 第二天直接 kubectl 继续用
# 彻底回收: kind delete cluster --name k8s-lab && docker rmi embed-svc:v1
```

验证点（本章交付判据）：①`/embed` 经域名访问返回 384 维向量；②压测触发 HPA 扩容；③滚动发布期间 fail 计数≈0。三者齐 = 你已经具备在 K8s 上交付一个真实 AI 服务的全部基础能力。

## 生产案例：本课程实测的四个坑（全部来自 VERIFICATION.md，可复现）

一：HF 镜像源与新版 huggingface_hub 的校验冲突（复现 2 次），参数化 ARG 解决；二：集群内服务 URL 必须 FQDN+端口（缺 .cluster.local 被 CoreDNS 转发拿到野 IP、缺 :8000 压测静默失败 HPA 无反应）；三：burst 压测打不进采样窗口，改 8 并发持续压；四：OrbStack VM 卡死（本机 2026-09 起），换 colima 兼容。这四个坑本身就是"本地实验环境与生产差异"的教材。

## 本章面试题

1. kind 的网络模型与生产集群的本质差异？（容器当节点/端口映射 vs 真虚机/CNI）
2. 集群内服务互访的 URL 规则？（FQDN=<svc>.<ns>.svc.cluster.local[:port]）
3. 镜像怎么进 kind？（kind load，绕过仓库；生产是 registry+imagePullPolicy）
4. 本地验证过的东西到生产还差什么？（真实负载/真实网络策略/真实证书/多节点拓扑）

## 自测清单

- [ ] 全链路三连（部署→压测 HPA→滚动发布）都真跑过
- [ ] 遇到 HPA 无反应能想到"压测没打进采样窗口"
- [ ] 能列出手里的环境与生产的差异清单


## 相关故障卡片（动手复现版）

本章知识点对应的真实故障，可在 kind 集群亲手制造并修复：

- [02 | ImagePullBackOff：镜像拉不下来](20-failures/02-ImagePullBackOff-镜像拉不下来.md)
