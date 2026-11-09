# 第 25 章 etcd 与控制面高可用 — 集群的心脏外科

## 25.1 开篇判断

三个问题：

1. 你知道你们 etcd 集群几个成员、什么磁盘、有没有备份、备份多久验一次恢复吗？四问有一个"不知道"，你的集群处于"心脏没做体检"状态。
2. API server 响应慢的时候，你分得清是 etcd 慢、是 watch 风暴，还是 API Priority & Fairness 排队吗？
3. 你能说出控制面组件（kube-apiserver/etcd/controller-manager/scheduler）各自挂掉的症状吗？

控制面是"平时无感、出事全场死"的部分。本章把这台手术台打开给你看。

## 25.2 原理

**etcd 的 raft 语义**：奇数成员（3/5/7），写入需多数派（quorum）确认。3 成员挂 1 可用、挂 2 不可用——**3 成员集群的容错是 1，不是 2**。扩容必须奇数；网络分区时少数派整体不可服务（脑裂不会发生，但可用性换一致性）。etcd 是强一致存储，K8s 的一切读最终都压在它身上。

**性能三件事**：
- 磁盘是命门：etcd 的 fsync 延迟直接决定写延迟。官方文档要求低延迟 SSD/NVMe，fsync >10ms 就是警报（`etcdctl endpoint status` 的 walFsyncDuration 指标）。
- 大对象是大忌：单个 value 默认上限 1.5MB，但实践里几百 KB 的对象（超大 ConfigMap/Secret）就会拖慢 etcd 与 watch。**不要把 ML 模型/大证书塞进 Secret**（某个 8MB"巨型 Secret 拖垮集群"的故事是各公司事故集的保留节目，模式：annotations/labels 也会进 etcd，把大数据塞 label 是隐蔽变体）。
- defrag 与压缩：etcd 历史版本默认保留（revision 保留策略），长期不 compact+defrag 会让 db 无限涨。定期 `etcdctl compact` + `defrag` 是运维标配（注意 defrag 会短暂影响成员，逐个做）。

**API server 的两道减压阀**：
- **Watch 机制**：客户端 watch 而非轮询，但 watch 本身有成本——超大集群（几万 Pod）一次全量 LIST 会让 etcd 与 apiserver 内存尖峰（"LIST 风暴"：某监控工具每分钟全量 list pod 的世界）。
- **API Priority & Fairness（APF）**：1.20+ 默认，把 API 按优先级分级排队，system/critical 优先，防止一个失控 client 把所有人饿死。配套老机制是 `--max-requests-inflight`。排查"间歇性 429"先看 APF:`kubectl get flowschema,prioritylevelconfiguration` 与 apiserver 的 `apiserver_flowcontrol_rejected_requests_total`。

**其他控制面组件的故障指纹**（排障速查）：
- kube-scheduler 挂：现有 Pod 正常，新 Pod 永远 Pending——**症状最温和**，也最容易被拖延不修。
- controller-manager 挂：Deployment 不再调和（删 Pod 不重建）、节点 NotReady 不被驱逐（eviction 控制器在里面）。
- apiserver 挂：一切 kubectl 失败，但**数据面 Pod 间流量完全不受影响**——这是 K8s 架构最重要的认知：控制面全挂，跑着的东西继续跑（直到需要调度/证书轮转）。

## 25.3 实操 lab：kind 集群的 etcd 体检与备份恢复演练

kind 的 etcd 在容器里，恰好是练手的好标本（生产命令相同，只是连接方式不同）。

```bash
# 1. 找到 etcd
kubectl -n kube-system get pods | grep etcd
ETCDPOD=$(kubectl -n kube-system get pods -o name | grep etcd | head -1 | cut -d/ -f2)

# 2. 健康与状态（背下这条 exec 模式）
kubectl -n kube-system exec $ETCDPOD -- sh -c \
  'ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
   --cacert=/etc/kubernetes/pki/etcd/ca.crt \
   --cert=/etc/kubernetes/pki/etcd/server.crt \
   --key=/etc/kubernetes/pki/etcd/server.key \
   endpoint status -w table'
# 看：RAFT TERM/LEADER/DB SIZE/IS LEADER

# 3. 检查告警与碎片
kubectl -n kube-system exec $ETCDPOD -- sh -c \
  'ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
   --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt \
   --key=/etc/kubernetes/pki/etcd/server.key alarm list'
# 预期：无输出（NOSPACE 警报是 db 满的前兆）

# 4. 备份（snapshot，这是生产的每日/每小时任务）
kubectl -n kube-system exec $ETCDPOD -- sh -c \
  'ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
   --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt \
   --key=/etc/kubernetes/pki/etcd/server.key \
   snapshot save /tmp/snap.db' 
kubectl -n kube-system cp $ETCDPOD:/tmp/snap.db /tmp/k8s-snap.db
ls -lh /tmp/k8s-snap.db

# 5. 验证快照（没验证过的备份=没有备份）
kubectl -n kube-system exec $ETCDPOD -- sh -c \
  'ETCDCTL_API=3 etcdctl snapshot status /tmp/snap.db -w table'
# 看 HASH/REVISION/TOTAL KEYS

# 6. 亲手造一个"巨型对象"体会 etcd 的反应（然后马上删）
kubectl -n default create configmap big --from-literal=x="$(head -c 500000 /dev/zero | base64 | tr -d '\0')"
kubectl -n kube-system exec $ETCDPOD -- df -h /var/lib/etcd 2>/dev/null | tail -1
# 观察 db 大小变化（几百 KB 级，单次无感——事故是几百个这种对象+每次get/ watch 的放大）
kubectl -n default delete configmap big

# 7.（认知演示）控制面挂掉时数据面活着：
docker exec kind-control-plane bash -c "pkill -f kube-apiserver || supervisorctl stop kube-apiserver" 2>/dev/null || \
  echo "kind 控制面容器内 apiserver 由静态 Pod 管理，生产演练：systemctl stop kubelet 或拔 apiserver 副本"
kubectl get pods 2>&1 | head -2   # 预期连接失败/超时
kubectl -n default run alive --image=busybox:1.36 --restart=Never -- true 2>&1 | head -1   # 也失败（调度要 apiserver）
# 但注意：已经在跑的 Pod 与 Service 转发不受影响 —— 生产里"API 超时但业务正常"就是这个状态，别重启业务！
```

预期总耗时 10-15 分钟。第 4/5 步的备份-验证闭环和第 7 步的"数据面还活着"是本章两个必带走认知。

## 25.4 生产案例：公开复盘与事故模式

案例一（公开可查证）：etcd 官方运维文档与多家公司公开博客反复出现的"db size 打满 NOSPACE"事故模式：默认配额 2GB（可调），大对象+未压缩的历史版本把 db 推到配额，etcd 进入只读告警，**整个集群 API 只读写入全部失败**，只能紧急 compact+defrag。预防三件套：配额告警（用到 60% 报）、定期 compact/defrag 的 CronJob 化、巨型对象准入拦截（Kyverno 限 value 大小）。

案例二（公开可查证）：Azure AKS 曾公开披露的两次大规模事故复盘（2021-2023 年间，AKS status history 页面可查）均涉及控制面组件/etcd 相关的连锁：一次是 API server 升级引发的风暴，一次是 etcd 成员异常导致的集群级不可用。行业级教训：**托管控制面也有可用性问题，"云托管"不等于"不用做控制面预案"**——你的预案是：数据面自愈能力评估（PDB/多副本跨节点）、降级运行手册（API 不可用期间哪些操作还做得了）、以及托管商 SLA 之外的冷备。

案例三（行业通病，模式）：没人验证过的备份。例行 snapshot 跑了两年，第一次真恢复时发现：备份的证书也过期了/恢复步骤文档的版本对不上/单副本 etcd 恢复的 quorum 初始化命令没人记得。**恢复演练的频率应该不低于每季度**，并且演练环境要真拉起一套集群跑业务验证（本课程第 27 章把演练做成 checklist）。

## 25.5 本章面试题

1. 3 节点 etcd 挂 2 个还能用吗？为什么？（不能，quorum=2；一致性优先于可用性）
2. etcd 的 db 满了会发生什么？怎么预防？（NOSPACE 只读告警→API 全挂；配额告警+compact/defrag+大对象拦截）
3. 为什么控制面全挂时业务还在跑？边界在哪？（数据面组件不依赖 apiserver 常联；边界=需要调度/新配置/证书轮转的操作）
4. APF 解决什么问题？（失控 client 饿死关键 API；分级排队与 429 语义）
5. etcd 备份的完整定义？（snapshot+验证+异地+含证书材料+定期恢复演练，缺一不可）

## 25.6 自测清单

- [ ] 会用 etcdctl endpoint status/ alarm list 做体检
- [ ] lab 完成了 snapshot 保存+status 验证闭环
- [ ] 能说出四个控制面组件各自的"挂掉指纹"
- [ ] 能解释 NOSPACE 事故链与三件套预防
- [ ] 你们的备份有恢复演练记录吗？（没有就安排）

> 调研粮备注：AKS 事故以其官方 status history 为准的公开记录；其余为公开文档与行业模式，无内部事故复盘一手数据。
