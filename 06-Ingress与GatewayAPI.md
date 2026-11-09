# 第 6 章 Ingress 与 Gateway API — 七层入口

> 心智图：
>
> ```
#   用户 →  (云LB/DNS)  →  Ingress Controller(Pod, 通常是nginx/traefik/envoy)
#                                │ 读取集群里所有Ingress规则
#                                ▼
#                          Ingress: host=api.example.com path=/orders
#                                │ (纯规则, 自己不转发流量)
#                                ▼
#                          Service(orders) → Pods
#
#   一句话: Ingress = 规则纸, Controller = 执行者。只装规则不装Controller = 什么都不会发生。
#   新一代: Gateway API (GatewayClass→Gateway→HTTPRoute, 角色分权, 1.25 GA的是v1.x CRD, 逐渐替代Ingress)
> ```

## 开篇判断

1) Ingress 对象本身转发任何流量吗？2) 我的注解列表超过 10 条了吗？3) TLS 证书在生产里是怎么续期的（手工 or cert-manager）？第三问答"手工"，本章对你有立竿见影的价值。
## 6.1 先破一个误解：Ingress 对象本身不做任何事

Ingress 只是 etcd 里的一纸路由规则。真正干活的是 **Ingress Controller**（一个需要你显式部署的 Deployment，常见 nginx-ingress、traefik、云厂商的 GLBC/ALB controller）。两者关系 = Spring 的 `@RequestMapping` 注解和 DispatcherServlet 的关系：规则与引擎。所以排障第一问永远是：**Controller 装了吗？装的是哪家？规则被它认了吗？**（`kubectl describe ingress` 看 `Events` 里有没有 admitted/annotations 相关报错。）

## 6.2 最小可用 Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "false"   # 注解是Controller方言! 换Controller要重写
spec:
  ingressClassName: nginx          # 指定哪个Controller认领
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /orders
        pathType: Prefix           # Prefix(前缀)/Exact(精确); ImplementationSpecific别用
        backend:
          service: { name: orders, port: { number: 80 } }
      - path: /
        pathType: Prefix
        backend:
          service: { name: web, port: { number: 80 } }
  tls:
  - hosts: [api.example.com]
    secretName: api-tls            # TLS证书存在Secret(type=kubernetes.io/tls)里
```

资深开发者注意三点：

1. **annotations 是 Controller 方言**，`nginx.ingress.kubernetes.io/*` 换 traefik 就全部失效——这是 Ingress 最大的历史包袱，也是 Gateway API 要解决的第一个问题。
2. **pathType 从 `ImplementationSpecific` 改为显式 `Prefix`/`Exact`**，否则不同 Controller 语义不同，迁移时是隐形炸弹。
3. Ingress 之后如果加了 API 网关（Kong/APISIX），通常直接用它们的 CRD 或干脆不用 Ingress——不要两层七层重复（Ingress→网关→Service 三跳是常见过度设计）。

## 6.3 TLS：证书从哪来

- 手动：`kubectl create tls secret api-tls --cert=fullchain.pem --key=privkey.pem`（过期前记得换，人肉 ops 的回归）。
- 自动：**cert-manager**（事实标准）：Issuer/ClusterIssuer CRD + 注解 `cert-manager.io/issuer: letsencrypt` → 自动签发+到期自动轮换。生产标配，第 14 章实战线会装。

## 6.4 Gateway API：为什么值得现在就了解

Ingress 的三个结构性缺陷 → Gateway API 的对应解法：

| Ingress 的病 | Gateway API 的药 |
|---|---|
| 注解方言，Controller 锁定 | 标准化的 HTTPRoute/GRPCRoute 字段 |
| 全部权限集中给集群管理员（写 Ingress 的平台组是瓶颈） | 角色分权：平台组管 Gateway（入口实例），业务组管自己的 Route（只写路由规则） |
| 只能表达"host+path"很原始 | header 匹配、权重分流（金丝雀）、超时重试、流量镜像一等公民 |

对象链：`GatewayClass`（哪种实现）→ `Gateway`（一个入口实例，带监听器）→ `HTTPRoute`（业务路由，attach 到 Gateway）。⚠️ 状态：Gateway API CRD 已 v1（GA 的是 Service APIs 框架与 HTTPRoute 核心部分，v1.0.0 起可用），但各实现的 conformance 参差；新项目可以直接上（尤其 envoyergateway/traefik/nginx 官方实现都成熟），存量 Ingress 不必急迁。

## 6.5 本地开发与生产入口的映射

- kind：Controller 用 NodePort/PortMapping 暴露，hosts 文件把 `api.example.com` 指到 127.0.0.1（第 14 章完整做一遍）。
- 云上生产：云 LB → Controller 的 Service(LoadBalancer) → 规则。DNS 用 CNAME 指云 LB 域名。
- 边缘身份：真实流量加 CDN/WAF 的话，X-Forwarded-For 的可信链要在 Controller 配置里校准，否则拿到的是 CDN IP——做风控/限流的团队在这里翻过车。

## Lab 6：kind 里装 Ingress 并路由两个"服务"

```bash
# 前置: Lab 1 的 kind 集群在。给 control-plane 映射80端口(如果建集群时没配, 可重建):
cat <<'EOF' > /tmp/kind-extraport.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
  kubeadmConfigPatches:
  - |
    kind: InitConfiguration
    nodeRegistration:
      kubeletExtraArgs: { node-labels: "ingress-ready=true" }
  extraPortMappings:
  - { containerPort: 80, hostPort: 80, protocol: TCP }
- role: worker
EOF
kind delete cluster --name k8s-lab && kind create cluster --name k8s-lab --config /tmp/kind-extraport.yaml

# 1. 装 ingress-nginx（约1-2分钟拉镜像）
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=ready pod -l app.kubernetes.io/component=controller --timeout=180s

# 2. 两个后端 + Ingress
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata: { name: echo-a }
spec:
  replicas: 2
  selector: { matchLabels: { app: echo-a } }
  template:
    metadata: { labels: { app: echo-a } }
    spec:
      containers: [ { name: app, image: hashicorp/http-echo:1.0, args: ["-text=A","-listen=:80"] } ]
---
apiVersion: v1
kind: Service
metadata: { name: echo-a }
spec: { selector: { app: echo-a }, ports: [ { port: 80 } ] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: echo-b }
spec:
  replicas: 2
  selector: { matchLabels: { app: echo-b } }
  template:
    metadata: { labels: { app: echo-b } }
    spec:
      containers: [ { name: app, image: hashicorp/http-echo:1.0, args: ["-text=B","-listen=:80"] } ]
---
apiVersion: v1
kind: Service
metadata: { name: echo-b }
spec: { selector: { app: echo-b }, ports: [ { port: 80 } ] }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: split }
spec:
  ingressClassName: nginx
  rules:
  - host: demo.local
    http:
      paths:
      - { path: /a, pathType: Prefix, backend: { service: { name: echo-a, port: { number: 80 } } } }
      - { path: /b, pathType: Prefix, backend: { service: { name: echo-b, port: { number: 80 } } } }
EOF

# 3. 验证（把域名解析到本机; ⚠️ apply后等10-20秒再curl——ingress controller同步端点有延迟,
#    刚apply完就curl /b 会拿到503, 误以为路由配错）
curl -s -H "Host: demo.local" http://127.0.0.1/a   # → A
curl -s -H "Host: demo.local" http://127.0.0.1/b   # → B
# 也可以 sudo sh -c 'echo "127.0.0.1 demo.local" >> /etc/hosts' 后直接 curl http://demo.local/a

# 4. 清理本lab对象（集群保留）
kubectl delete ing split && kubectl delete deploy,svc echo-a echo-b
```

验证点：同域名的 `/a` `/b` 路由到不同后端；把 Service `echo-b` 删掉再 curl `/b` 会得到 503（Controller 已无健康 upstream）——记住这个 503 的样子，第 15 章排障会用到。

## 生产案例：注解地狱的两个真实代价（公开可查证）

一：IngressNightmare（CVE-2025-1974 系列，2025，评分至 9.8）——注解成为向特权 controller 注入配置的通道，"能建 Ingress"等价于集群执行权。二：实现锁定——注解与实现强绑定，换 controller 等于重写全部规则。两者的系统解都是 Gateway API（第 16 章生产级展开，含分权 lab）。

## 本章面试题

1. Ingress 对象本身做任何事吗？（不，controller 是干活的，对象只是期望状态）
2. TLS 证书在生产里怎么进集群？（cert-manager 自动签发/续期）
3. Ingress vs Gateway API 的分权差异？（第 16 章四对象模型）
4. 本地开发的入口怎么映射到生产？（Host 头本地复现 vs 生产域名+证书）

## 自测清单

- [ ] lab 里装了 ingress-nginx 并路由了两个服务
- [ ] 能解释 apply 后 503 的端点传播延迟（本课程实测 10-20s）
- [ ] 能说出注解的两大代价各对应什么解法


## 相关故障卡片（动手复现版）

本章知识点对应的真实故障，可在 kind 集群亲手制造并修复：

- [13 | 证书过期：TLS 握手失败](20-failures/13-证书过期-TLS握手失败.md)
