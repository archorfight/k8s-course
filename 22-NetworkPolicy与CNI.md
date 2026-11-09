# 第 22 章 NetworkPolicy 与 CNI 深入 — 集群网络的隐形战场

## 22.1 开篇判断

三个问题：

1. 你的集群里，default 命名空间的 Pod A 能不能访问 kube-system 的 etcd？（如果 NetworkPolicy 为空，答案是"理论上能到端口层面"——这不是设计，是没人管。）
2. 你知道你们用的什么 CNI 吗？Cilium/Calico/flannel 各自为什么被选？
3. 出过"某个调试 Pod 把 DNS 打挂"的事故吗？（NetworkPolicy 不管这个，但 eBPF CNI 的 visibility 能让定位从 1 小时变 5 分钟。）

K8s 网络的默认姿态是"全通"，而生产网络的安全与稳定性几乎都建立在"默认拒绝+显式放行"上。本章讲 NetworkPolicy 语义、CNI 选型、以及排障工具链。

## 22.2 原理

**K8s 网络模型四约束**（CNI 的存在理由）：Pod 间无需 NAT 直接互通；节点上的代理（kubelet）能和本节点所有 Pod 通信；Pod 看到的自己 IP 与外界看到的一致（无 NAT 歧义）；podIP:podPort 语义全网唯一。任何 CNI 的实现方案（overlay/路由/BGP/eBPF）都是在满足这四条下的取舍。

**CNI 三大流派**：
- Overlay（flannel/VXLAN）：封装报文，配置简单、性能损耗 5-15%，小集群够用。
- 路由/BGP（Calico）：不封装，三层路由直通，性能好，NetworkPolicy 由 iptables/ipset 或 eBPF 实现，策略能力强。
- eBPF（Cilium）：内核态转发+策略+可观测（Hubble 一条命令看 flow），性能最好、功能最多，但内核版本要求与运维门槛最高。2026 基线：新集群默认候选，存量集群按升级窗口评估。

**NetworkPolicy 语义三定律**（面试必考，事故常发）：
1. **策略是白名单叠加**：一个 Pod 被任何 NetworkPolicy 选中（podSelector 命中）后，未被任何规则显式 allow 的流量**全部拒绝**。
2. **默认允许**：未被任何策略选中的 Pod 保持全通——所以"只给一个命名空间加策略"不会影响别的命名空间，但会让"该 ns 与别的 ns 之间"变成需要显式放行。
3. **策略无方向优先级**：ingress 和 egress 独立计算，没写 egress 的策略不影响出站。

高频陷阱：①写 policy 时忘了放行 DNS（UDP/TCP 53 到 kube-dns），所有域名解析挂掉，症状是"服务时通时不通"；②`ipBlock` 与 overlay 网段冲突（Pod IP 在 cidr 里但实际经 VXLAN 封装，行为依 CNI 而异）；③NamespaceSelector 在非命名空间默认 CNI 插件上必须用 CNI 自己的扩展（如 Calico 的全局策略）才能跨 ns 正确匹配 label。

## 22.3 实操 lab：从全通到默认拒绝，再放行一条最小链路

前提：kind 集群。注意 kindnet（kind 默认 CNI）**不支持** NetworkPolicy——这本身就是个教学点：换 CNI 是 NetworkPolicy 的前置条件。lab 顺带演示换装 Calico。

```bash
# 1. 证明"全通"：跨 ns 裸访问（先建环境）
kubectl create ns netlab
kubectl -n netlab create deploy srv --image=hashicorp/http-echo:1.0.0 -- --text=OK --listen=:5678
kubectl -n netlab expose deploy srv --port 80 --target-port 5678
kubectl -n netlab run probe --image=busybox:1.36 --restart=Never -- sleep 600
kubectl -n netlab exec probe -- wget -qO- -T 3 http://srv.netlab.svc.cluster.local   # 预期 OK

# 2. 换 CNI：kindnet → Calico（约 3 分钟）
kubectl delete ds -n kube-system kindnet
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.2/manifests/calico.yaml
kubectl -n kube-system rollout status ds calico-node --timeout=300s
kubectl -n netlab delete pod probe   # 重建让 Pod 拿到 Calico 网络
kubectl -n netlab run probe --image=busybox:1.36 --restart=Never -- sleep 600
kubectl -n netlab exec probe -- wget -qO- -T 3 http://srv.netlab.svc.cluster.local   # 仍然 OK

# 3. 默认拒绝：deny-all 入站（行业标配起步线）
cat <<'EOF' | kubectl -n netlab apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-ingress }
spec:
  podSelector: {}          # 选中 ns 内所有 Pod
  policyTypes: [Ingress]   # 没有 ingress 规则 = 全部入站拒绝
EOF
kubectl -n netlab exec probe -- wget -qO- -T 3 http://srv.netlab.svc.cluster.local
# 预期：超时 —— 同 ns 内也不通（没有魔法"同 ns 放行"）

# 4. 最小放行：只允许带 label 的客户端到 80
cat <<'EOF' | kubectl -n netlab apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-probe-to-srv }
spec:
  podSelector: { matchLabels: { app: srv } }
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector: { matchLabels: { run: probe } }
    ports: [{ protocol: TCP, port: 80 }]
EOF
kubectl -n netlab exec probe -- wget -qO- -T 5 http://srv.netlab.svc.cluster.local   # 预期恢复 OK

# 5. 经典陷阱：出站默认拒绝后 DNS 挂
cat <<'EOF' | kubectl -n netlab apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-egress }
spec:
  podSelector: {}
  policyTypes: [Egress]
EOF
kubectl -n netlab exec probe -- wget -qO- -T 3 http://srv.netlab.svc.cluster.local
# 预期失败 —— 因为 DNS 查询也被 egress 策略挡了（日志会卡在解析）
# 放行 DNS：
cat <<'EOF' | kubectl -n netlab apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-dns }
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
  - to:
    - namespaceSelector: {}          # kube-dns 在 kube-system
    ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }
EOF
kubectl -n netlab exec probe -- wget -qO- -T 5 http://srv.netlab.svc.cluster.local   # 恢复 OK
```

预期总耗时 12-15 分钟（换 CNI 最耗时）。第 3→4→5 步的三段演示是 NetworkPolicy 的全部核心语义，值得录屏。

## 22.4 生产案例：公开复盘与事故模式

案例一（行业通病，模式）：DNS 成为单点。加了默认拒绝 egress 后全集群域名解析失败（本 lab 第 5 步的放大版）；另一变体是 CoreDNS 的 NodeLocal DNSCache 未开导致 DNS 查询风暴（每 Pod 每次解析都打 CoreDNS）。CNCF CoreDNS 官方文档与各大厂公开分享均把 NodeLocal DNSCache 列为规模化标配。事故链：上游 DNS 慢 → ndots:5 导致每次域名解析变成多次查询 → CoreDNS CPU 打满 → 所有服务"随机"超时。

案例二（公开事件模式）：ipBlock 语义陷阱。大量社区 issue 记录同一模式：用 `ipBlock: 10.0.0.0/8` 放行"集群网段"，但 overlay 模式下对端 Pod IP 在该段内、策略却被 CNI 解释为节点 IP 空间，行为与预期相反。教训：**ipBlock 只用于真正的外部网段，集群内放行一律用 podSelector/namespaceSelector**。

案例三（公开可查证）：Cilium 的公开案例集（Isovalent/Cilium 官网案例页）展示了 eBPF 可观测性把网络MTTR 从小时级降到分钟级的多个客户复述。核心增量是 Hubble：`hubble observe --pod x` 一条命令看到真实 flow（哪个策略 deny 了哪个包）。传统 iptables 时代这需要抓包+逐条规则 dump，是高级技能；eBPF 时代它是 oncall 基本功。

## 22.5 本章面试题

1. NetworkPolicy 的三定律？（白名单叠加、未选中默认全通、ingress/egress 独立）
2. 为什么加了默认拒绝 egress 后服务全挂？（DNS 53 未放行——必答点）
3. ipBlock 的适用边界？（仅外部网段；集群内用 podSelector）
4. 三大 CNI 流派的取舍？（overlay 简单有损耗/路由性能好/eBPF 性能+可观测+门槛）
5. ndots:5 是什么坑？（Service 域名后缀搜索列表导致解析次数放大，配合 NodeLocal DNSCache 缓解）
6. Pod 到 Pod 的流量路径在你集群里怎么走？（按自己 CNI 画出 overlay 封装或路由或 eBPF 转发——答不出说明从没看过自己的集群）

## 22.6 自测清单

- [ ] 能复述三定律并各举一个事故场景
- [ ] lab 里完成了 deny-all→最小放行→DNS 陷阱的完整链路
- [ ] 知道自己生产集群的 CNI 及其策略实现（iptables/eBPF）
- [ ] 能解释 NodeLocal DNSCache 解决什么
- [ ] 会用 Cilium/Hubble 或抓包定位"策略挡了我"类问题

> 调研粮备注：无内部事故一手数据；CoreDNS/ndots 与 ipBlock 陷阱均为社区公开高频模式。


## 相关故障卡片（动手复现版）

本章知识点对应的真实故障，可在 kind 集群亲手制造并修复：

- [09 | DNS 解析失败：跨 namespace 用短名](20-failures/09-DNS解析失败-跨namespace短名.md)
- [18 | NetworkPolicy 默认全拒：请求超时](20-failures/18-NetworkPolicy全拒-超时.md)
