# 第 5 章 Service — 集群内的服务发现与负载均衡

> 心智图：
>
> ```
#   你调用 http://orders.default.svc.cluster.local:8080
#        │  DNS(由CoreDNS提供, 名字规则: &lt;svc&gt;.&lt;ns&gt;.svc.cluster.local)
#        ▼
#   Service (虚拟ClusterIP, 10.96.x.x)  ←─稳定入口, 与Pod生死无关
#        │  selector: app=orders  ──选择──→  label匹配 且 readiness通过 的Pod
#        ▼
#   EndpointSlice: [10.244.1.5:8080, 10.244.2.3:8080, ...]   ←真正的后端列表
#        │  kube-proxy在每节点写的iptables/ipvs规则做DNAT
#        ▼
#   Pod  ←──── 客户端无感知
#
#   类型光谱: ClusterIP(集群内) → NodePort(每节点开端口) → LoadBalancer(云LB) → ExternalName(DNS CNAME)
> ```

## 开篇判断

1) ClusterIP 是真 IP 还是幻象？2) Pod 就绪了但没流量，中间断在哪一环？3) 我知道 endpoints 和副本数应该相等吗？Service 是"最简单又最多事故"的对象，三个问题定位你的段位。
## 5.1 解决的问题：Pod IP 是一次性的

Pod 会死、会被重建、IP 会变。Service 做了三件事把它藏起来：

1. **稳定的虚拟 IP + DNS 名**：`orders.prod.svc.cluster.local`，终生不变。
2. **动态后端选择**：label selector 圈定候选，readiness 未通过的 Pod 不会进 EndpointSlice（这是 Service 和"DNS 直连 Pod"的本质区别）。
3. **四层负载均衡**：kube-proxy 在每个节点写转发规则，默认 iptables 模式按连接随机（不是按请求！），ipvs 模式支持更多策略。

**认知要点**：Service 是 L4（TCP/UDP）负载均衡，**不理解 HTTP**。同一连接内做任何事都打到同一后端；它不健康检查后端（靠 Pod 的 readinessProbe 间接实现）、不支持按 path 分流（那是 Ingress 的事）。

## 5.2 四种类型与一个特例

```yaml
apiVersion: v1
kind: Service
metadata: { name: orders }
spec:
  type: ClusterIP          # 默认。集群内可达
  selector: { app: orders }
  ports:
  - port: 80               # Service自己的端口
    targetPort: 8080       # 转到Pod的哪个端口(可以是容器里声明的名字)
```

- **ClusterIP**：服务间调用的默认选择。
- **NodePort**：在每个节点开一个 30000-32767 的端口转发到 Service。调试用，生产别直接当入口（节点挂了 IP 就变、无 TLS）。
- **LoadBalancer**：NodePort + 云厂商 LB。云上对外暴露服务的正道；本地 kind 里可用 `metallb` 或 kind 自带的 extraPortMappings 模拟（第 14 章）。
- **ExternalName**：返回 CNAME，指到外部域名。少用，且注意它不做任何代理，客户端直连外部。

**Headless Service（`clusterIP: None`）**：不做负载均衡，DNS 直接返回所有 Pod IP。两个用途：Client 端负载均衡（gRPC 场景的标配，因为 gRPC 长连接会让 Service 的"按连接均衡"退化成"所有流量在一个连接里"——**gRPC + 普通 Service = 负载不均，资深后端最常撞的分布式坑**）；以及给 StatefulSet 提供每 Pod 稳定 DNS（`web-0.pg.svc...`）。

## 5.3 selector 没匹配上：最经典的"服务不通"

症状：DNS 能解析、curl 超时或 connection refused。根因九成是：

```bash
kubectl get endpointslice -l kubernetes.io/service-name=orders
# ENDPOINTS 为空 → selector 的 label 和 Pod 的 label 对不上
# (注意 label 是精确字符串匹配, app=Orders ≠ app=orders)
```

排查次序固定三步：①endpointslice 有没有 IP（selector 对不对、Pod ready 没）→ ②Pod 内服务真的监听在 targetPort 上（`kubectl exec` + netstat/curl localhost）→ ③NetworkPolicy 是否放行（第 12 章提，默认无策略=全通）。

## 5.4 topology Aware Routing 与就绪门槛

同 zone 优先路由（原 topology hints，1.21+ 叫 Topology Aware Routing，注解 `service.kubernetes.io/topology-mode: Auto`）：跨 AZ 流量费钱且延迟高，开启后 kube-proxy 优先把流量发到同 zone 后端。前提是集群正确打了 zone label 且后端分布合理。⚠️ 后端少于 minimumHealthyEndpoints 时自动退回全cluster。

## 5.5 给 Java 老兵的映射

- Service ≈ 你做过的 "VIP + LVS/Nginx upstream"，区别是 upstream 列表自动维护（由 readiness 驱动）。
- 熔断/限流/灰度**不在** Service 层——那是 Istio/Linkerd（mesh，把 sidecar proxy 编排起来）或网关层的事。K8s 原生 Service 刻意保持 dumb。
- 服务间调用走 FQDN（`orders.prod.svc.cluster.local`）而不是 IP 硬编码；同 namespace 可短名 `orders`。这个 DNS 解析在 Pod 内由 CoreDNS 完成，Pod 的 `/etc/resolv.conf` 有 `search` 域列表实现短名补全——排查 DNS 问题时 `kubectl run -it --rm dnstest --image=busybox -- nslookup orders` 是标准动作。

## Lab 5：Service 生死与端点摘除

```bash
# 1. 部署带readiness的 Deployment + Service
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata: { name: svc-demo }
spec:
  replicas: 3
  selector: { matchLabels: { app: svc-demo } }
  template:
    metadata: { labels: { app: svc-demo } }
    spec:
      containers:
      - name: app
        image: hashicorp/http-echo:1.0
        args: ["-text=hello-from-svc-demo", "-listen=:8080"]
        readinessProbe:
          httpGet: { path: /, port: 8080 }
          initialDelaySeconds: 2
---
apiVersion: v1
kind: Service
metadata: { name: svc-demo }
spec:
  selector: { app: svc-demo }
  ports: [ { port: 80, targetPort: 8080 } ]
EOF

# 2. 看后端端点（应有3个IP）
kubectl get endpointslice -l kubernetes.io/service-name=svc-demo

# 3. 从测试Pod访问（会随机命中一个后端）
kubectl run curl1 --image=curlimages/curl:8.8.0 --rm -it --restart=Never -- \
  sh -c 'for i in 1 2 3 4; do curl -s svc-demo; echo; done'

# 4. 把一个Pod标记为不就绪, 观察端点即时摘除
# (⚠️ 不要用"readiness路径改错"的写法：http-echo 对任何路径都返回200, 探针不会失败；
#  这里改探一个没人监听的端口, 干净利落地触发 NotReady)
kubectl patch deploy svc-demo -p '{"spec":{"template":{"spec":{"containers":[{"name":"app","readinessProbe":{"tcpSocket":{"port":9999}}}]}}}}'
# ↑ readiness改探 9999 端口 → 无连接 → 全部变NotReady (观察ready数下降即可, 这是可逆演示)
kubectl get pods -l app=svc-demo -w
# 确认NotReady后, Service没有可用后端:
kubectl run curl2 --image=curlimages/curl:8.8.0 --rm -it --restart=Never -- curl -s --max-time 3 svc-demo
# 预期: 超时/拒绝 → 证明 readiness 是流量的门

# 5. 清理
kubectl delete deploy,svc svc-demo
```

验证点：①就绪 Pod 数=EndpointSlice 里的 IP 数；②全部 NotReady 后 curl 失败——**Service 转发的是"就绪的后端"，不是"活着的 Pod"**。

## 生产案例：selector 失配与"服务半通"（行业高频模式）

label 被某次重构悄悄改掉：Service 的 endpoints 变空或只剩部分 Pod——症状是"服务时通时不通"（取决于负载均衡打到哪个副本）。诊断一条命令：`kubectl get endpoints &lt;svc&gt;`，端点数与副本数不符即查 label。本课程第 5 章 lab 也实证了"探针失败导致端点摘除"的半通形态。

## 本章面试题

1. ClusterIP 是怎么实现的？（kube-proxy 三模式：iptables/IPVS/eBPF）
2. Service 与 endpoints/endpointslice 的关系？谁在维护？
3. headless Service 什么时候用？（StatefulSet、gRPC 直连、客户端自负载均衡）
4. ExternalName 的坑？（DNS CNAME 级，无健康检查、不参与策略）

## 自测清单

- [ ] 能说清 endpoints 与副本数不一致的三种原因（label 失配/探针失败/未就绪）
- [ ] lab 里观察过端点摘除与恢复
- [ ] 知道自己生产集群 kube-proxy 用的什么模式


## 相关故障卡片（动手复现版）

本章知识点对应的真实故障，可在 kind 集群亲手制造并修复：

- [09 | DNS 解析失败：跨 namespace 用短名](20-failures/09-DNS解析失败-跨namespace短名.md)
- [10 | Service 选不到 Pod：selector 标签不匹配](20-failures/10-Service选不到Pod-selector标签不匹配.md)
- [12 | Readiness 探针端口错：Pod 永远 0/1 Ready](20-failures/12-Readiness探针端口错-不进endpoints.md)
- [16 | Service targetPort 写错：connection refused](20-failures/16-targetPort错-连接拒绝.md)
