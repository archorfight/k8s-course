# 第 16 章 Gateway API 生产落地 — 把七层入口从 Ingress 迁出去

> 本章起进入课程的运营商级部分。第 6 章你已经会用 Ingress，但真到生产，Ingress 的三个天花板会依次撞上：注解地狱、跨团队权限边界、多实现锁定。Gateway API 是社区给出的正式答案（GA 于 2023 年 10 月，Networking v1），本章讲清它解决什么、怎么迁、迁的时候踩什么。

## 16.1 开篇判断

先回答三个问题，决定你该不该现在迁：

1. 你的 Ingress 注解是否超过 15 条？超过说明你已经在用注解编程，注解没有 schema 校验，写错一个字符静默失败——这是注解地狱的典型体征。
2. 是否存在"平台组管入口、业务组管路由"的分权需求？Ingress 把两者捏在一个对象里，做不到。Gateway API 的 Gateway/HTTPRoute 角色分离天然支持。
3. 是否考虑过换实现（nginx → Envoy 系）？Ingress 注解和实现强绑定，换实现等于重写全部规则；Gateway API 是标准 API，实现可替换。

三个都是"否"，本章当资料读；有一个"是"，认真做 lab。

## 16.2 原理：角色分离是核心增量

Gateway API 的对象模型：

- **GatewayClass**：由基础设施方（平台组/云厂商）部署，声明"哪类网关实现可用"。类比 IngressClass，但它是整个分权模型的根。
- **Gateway**：一个入口实例（IP/LB + 监听端口 + TLS）。由平台组创建，定义监听器时用 `allowedRoutes.namespaces` 白名单声明"哪些命名空间的路由可以挂到我身上"。
- **HTTPRoute/GRPCRoute/TCPRoute/UDPRoute/TLSRoute**：业务组在自己的命名空间里创建，通过 `parentRefs` 挂到某个 Gateway 的监听器上。
- **ReferenceGrant**：跨命名空间引用（如 HTTPRoute 引用另一个 namespace 的证书/服务）必须显式授权，默认禁止——这是 Ingress 时代完全缺失的安全边界。

记住一句话：**Ingress 是一个对象干所有事，Gateway API 是四个对象各干各的事，边界即权限**。

状态机差异也要懂：HTTPRoute 的 `status.parents` 会告诉你每个 Gateway 是 `Accepted` 还是 `RefutedDueTo...` 原因码。Ingress 失败只能去翻 controller 日志；Gateway API 失败原因写进对象 status，这是排障效率的代差。

实现兼容性现状（2026 基线）：Envoy Gateway、Gateway API Ingress Controller（nginx 官方新方案）、Cilium、Traefik、Istio 均已支持 v1；AWS VPC Lattice、GKE Gateway 均为托管实现。选型时确认你要用的字段（如 HTTPRoute 的 `requestHeaderModifier`、`retry`）在目标实现的 README 兼容矩阵里是 Core 还是 Extended 支持。

## 16.3 实操 lab：kind 上双轨运行 Ingress 与 Gateway API

前提：第 14 章的 kind 集群还在（没有就回去按第 14 章重建，预期 3 分钟）。

```bash
# 1. 安装 Gateway API CRD（约 30s）
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml

# 2. 装 Envoy Gateway（约 1 分钟）
helm install eg oci://docker.io/envoyproxy/gateway-helm --version v1.2.4 -n envoy-gateway-system --create-namespace
kubectl wait --for=condition=Available deployment --all -n envoy-gateway-system --timeout=180s

# 3. 创建 GatewayClass（Envoy Gateway 自带一个，确认即可）
kubectl get gatewayclass
# 预期：名字 envoy-gateway，CONTROLLER GatewayClassesAccepted

# 4. 部署两个业务（复用第 6 章的 app-a/app-b，没有就快速拉起）
kubectl create ns dual
kubectl -n dual create deployment app-a --image=hashicorp/http-echo:1.0.0 -- --text=A --listen=:5678
kubectl -n dual create deployment app-b --image=hashicorp/http-echo:1.0.0 -- --text=B --listen=:5678
kubectl -n dual expose deployment app-a --port 80 --target-port 5678
kubectl -n dual expose deployment app-b --port 80 --target-port 5678

# 5. 创建 Gateway：80 端口监听，只允许 dual 命名空间挂路由
cat <<'EOF' | kubectl apply -f -
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: demo-gw
  namespace: envoy-gateway-system
spec:
  gatewayClassName: envoy-gateway
  listeners:
  - name: http
    port: 80
    protocol: HTTP
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gw: demo
EOF
kubectl -n dual label ns dual gw=demo

# 6. 业务侧 HTTPRoute（注意它在 dual 命名空间，平台组不需要参与）
cat <<'EOF' | kubectl apply -f -
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ab-route
  namespace: dual
spec:
  parentRefs:
  - name: demo-gw
    namespace: envoy-gateway-system
  hostnames: ["lab.local"]
  rules:
  - matches:
    - path: { type: PathPrefix, value: /a }
    backendRefs: [{ name: app-a, port: 80 }]
  - matches:
    - path: { type: PathPrefix, value: /b }
    backendRefs: [{ name: app-b, port: 80 }]
EOF

# 7. 验证状态机（这一步是重点，看 Accepted）
kubectl -n dual get httproute ab-route -o jsonpath='{.status.parents[0].conditions}' | head -c 400; echo

# 8. 拿到网关 IP 并验证（Envoy Gateway 默认 LoadBalancer，kind 里等 1-2 分钟或用 nodePort 方式）
kubectl -n envoy-gateway-system get gateway demo-gw -o jsonpath='{.status.addresses[0].value}'; echo
# 拿到 IP 后：
GWIP=$(kubectl -n envoy-gateway-system get gateway demo-gw -o jsonpath='{.status.addresses[0].value}')
curl -s -H "Host: lab.local" http://$GWIP/a   # 预期 A
curl -s -H "Host: lab.local" http://$GWIP/b   # 预期 B

# 9. 观察分权：把 dual 命名空间的 gw 标签删掉，路由会被网关拒收
kubectl label ns dual gw- && sleep 3
kubectl -n dual get httproute ab-route -o jsonpath='{.status.parents[0].conditions}' | grep -o 'Accepted:[a-zA-Z]*'
# 预期 Accepted:False，原因 RefutedDueTo... —— 权限边界是硬的
kubectl label ns dual gw=demo   # 恢复
```

预期总耗时 8-12 分钟。第 9 步的"拒收"演示是本章 lab 的灵魂：**分权不是文档约定，是 API 强制**。

进阶练习（选做）：给 Gateway 加第二个 HTTPS 监听器并挂自签证书，观察 TLS 监听器要求 `allowedRoutes.kinds` 匹配；再写一个 ReferenceGrant 让 HTTPRoute 引用另一个命名空间的 Secret，验证默认拒绝。

## 16.4 生产案例：公开复盘与事故模式

案例一（公开报道，可查证）：特斯拉 2018 年 K8s 集群失守。攻击者发现一个没有认证的 K8s Dashboard 暴露在公网，拿到凭证后访问了内网的 S3 桶和算力，用来挖矿。与本章的关联点：**入口层的权限模型决定了爆炸半径**。Ingress 时代"谁能创建指向任意服务的入口"没有答案；Gateway API 的 allowedRoutes + ReferenceGrant 把这个边界变成了 API 对象。这个事件本身不是 Ingress 的锅，但它定义了为什么入口层需要显式的跨命名空间授权语义。

案例二（公开 CVE，可查证）：2025 年 3 月 ingress-nginx 的 IngressNightmare 系列漏洞（CVE-2025-1974 等，评分最高 9.8）。根因是 nginx ingress controller 的 admission webhook 对注解内容处理不当，拥有创建 Ingress 权限的用户可以注入配置拿到 controller 所在节点的命令执行——而 controller 通常跑在特权位置。社区修复之外，所有讨论落到同一个结论：**注解本质上是把任意配置注入权交给了 Ingress 创建者**。Gateway API 用带 schema 的字段替代注解，注入面显著收窄。这是"注解地狱"从工程美学问题升级为安全问题的标志性事件。

案例三（行业通病，非单一事故）：大型团队共用一个 Ingress 对象。多个业务组改动同一个 YAML，一次错误提交影响所有挂载的路由——这类"共享对象"事故在各公司复现率极高，是迁移 Gateway API 最常见的直接动因。缓解手段是本章的分权模型，而不是"约定大家小心"。

## 16.5 本章面试题

1. Ingress 和 Gateway API 最本质的区别是什么？（提示：不是功能多少，是角色/权限模型——Gateway/Route 分离 + ReferenceGrant）
2. HTTPRoute 创建后不生效，你的排查路径？（status.parents 条件码 → Gateway 监听器 allowedRoutes → ReferenceGrant → 实现兼容矩阵，四步）
3. 为什么说 Ingress 注解是安全隐患？（无 schema 校验 + 注解可携带实现特定的配置注入，参考 IngressNightmare）
4. 跨命名空间引用在 Gateway API 里如何做到默认安全？（ReferenceGrant 显式白名单）
5. 迁移策略：生产环境怎么从 Ingress 平滑迁到 Gateway API？（双轨并行、按域名灰度切流、注解先做清单化翻译、保留回滚开关）

## 16.6 自测清单

- [ ] 能说出 Gateway API 四个核心对象及各自归属的角色
- [ ] 能解释 HTTPRoute status.parents 的条件码机制
- [ ] lab 中完成了 allowedRoutes 拒收演示并能复述原因码
- [ ] 能讲出至少两个"注解地狱"在生产中的真实代价
- [ ] 能设计一个 Ingress→Gateway API 的灰度迁移方案（双轨 + 切流 + 回滚）

> 调研粮备注：本章案例采用公开可查证事件（Tesla 2018、CVE-2025-1974）。原计划的内部调研包（各公司迁移踩坑一手数据）未到位，行业通病部分标注为"模式"而非具体事故。


## 相关故障卡片（动手复现版）

本章知识点对应的真实故障，可在 kind 集群亲手制造并修复：

- [13 | 证书过期：TLS 握手失败](20-failures/13-证书过期-TLS握手失败.md)
