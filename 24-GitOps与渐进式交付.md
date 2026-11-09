# 第 24 章 GitOps 与渐进式交付 — ArgoCD + Rollouts

## 24.1 开篇判断

三个问题：

1. 你们生产集群的变更，"谁在什么时候改了什么"能 5 分钟内查清吗？（kubectl 手改的世界里答案是"翻 audit log 一小时"。）
2. 回滚一个坏发布要多久？（>10 分钟说明没有自动化回滚路径。）
3. 十个集群发布同一个应用，你能保证十份配置一致吗？（第 18 章说过：不能保证就是裸奔。）

GitOps 的定义（CNCF/OpenGitOps 四原则，背下来）：**声明式、版本化且不可变、自动拉取（Pull）、持续调和**。核心翻转：CI 推镜像，GitOps 控制器从 Git **拉取**期望状态并调和集群——Git 是唯一事实源，集群是 Git 的投影。

## 24.2 原理

**工具版图**：ArgoCD（事实标准，UI 好、生态大）vs Flux（更精简、纯 CLI、内核化）。选谁都行，别两个都用。Helm/Kustomize 是打包层不是部署层——"Helm vs ArgoCD"是伪问题，ArgoCD 部署的就是 Helm chart。

**ArgoCD 核心机制**：
- Application CR：声明"Git 仓库某路径 ↔ 集群某 namespace"的映射。
- 三种同步策略：manual / auto（sync=true）/ auto-selfHeal（**关键**：手改集群会被自动改回——没有 selfHeal 的 GitOps 是"半 GitOps"，kubectl 手改仍会存活并漂移）。
- 漂移检测：周期 diff 实际状态 vs 期望状态，UI 直接显示哪个字段被人改了。这是回答判断题 1 的机制基础。
- App-of-apps 模式：用一个根 Application 管理其他所有 Application——多团队/多集群的目录结构由此展开。

**渐进式交付（Argo Rollouts）**：替代 Deployment 的 Rollout CR，策略化发布：
- Canary：按权重切流（5%→25%→50%→100%），配合 Gateway API/网格做入口级权重；分析步（Analysis）可以接 Prometheus，指标不达标自动回滚——**把"发布成功"从人的判断变成数据的判断**。
- BlueGreen：双环境切换，验证后一刀切流量。
- 与第 4 章 Deployment 的关系：Rollout 是 drop-in 替代（同 podTemplate），K8s 原生 Deployment 只有 maxSurge/maxUnavailable 的粗粒度，没有权重与指标门禁。

**安全串联**（呼应第 20 章案例三）：GitOps 后 CI 不再持有集群凭证（它只 push Git），部署凭证收敛到 ArgoCD 一处，且可以按 App 最小化。这是"效率工具同时是安全工具"的典型。

## 24.3 实操 lab：ArgoCD 起步 + 自愈演示 + Canary 门禁

```bash
# 1. 装 ArgoCD（约 3 分钟）
kubectl create ns argocd
kubectl -n argocd apply -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd rollout status deploy/argocd-server --timeout=300s
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo "  <- admin 密码"

# 2. 用官方示例库建第一个 Application
cat <<'EOF' | kubectl apply -f -
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: guestbook, namespace: argocd }
spec:
  project: default
  source:
    repoURL: https://github.com/argoproj/argocd-example-apps.git
    targetRevision: HEAD
    path: guestbook
  destination:
    server: https://kubernetes.default.svc
    namespace: guestbook
  syncPolicy:
    automated: { prune: true, selfHeal: true }   # 自动同步+自愈+删除孤儿资源
    syncOptions: ["CreateNamespace=true"]
EOF
sleep 5 && kubectl -n guestbook get deploy,pod   # 预期 guestbook-ui 已部署

# 3. 自愈演示（GitOps 的灵魂 30 秒）
kubectl -n guestbook scale deploy/guestbook-ui --replicas=3
sleep 20 && kubectl -n guestbook get deploy guestbook-ui   # 副本数被自动改回 1
# 注意：如果 20 秒没改回，多等一会（调和周期）。这就是"kubectl 手改无效"的世界

# 4. UI 看一眼（可选）
kubectl -n argocd port-forward svc/argocd-server 8080:443 &
# 浏览器 localhost:8080，admin + 第 1 步密码，看 guestbook 的 diff/同步历史

# 5. 装 Argo Rollouts 并体验指标门禁 Canary（约 3 分钟）
kubectl create ns argo-rollouts
kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml
kubectl -n argo-rollouts rollout status deploy/argo-rollouts --timeout=300s
# rollouts kubectl 插件（可选但强烈推荐）：
# brew install argo-rollouts   # 或 curl -LO .../kubectl-argo-rollouts-linux-amd64

# 6. 一个带 Prometheus 门禁的 Rollout（Analysis 模板：错误率>5% 则中止）
cat <<'EOF' | kubectl apply -n guestbook -f -
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata: { name: success-rate }
spec:
  metrics:
  - name: success-rate
    interval: 10s
    count: 3
    successCondition: result[0] >= 0.95
    failureLimit: 1
    provider:
      prometheus:
        address: http://prometheus-kube-prometheus-prometheus.monitoring:9090
        query: |
          sum(rate(http_requests_total{namespace="guestbook",code!~"5.."}[30s]))
          /
          sum(rate(http_requests_total{namespace="guestbook"}[30s]))
---
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: { name: guestbook-rollout }
spec:
  replicas: 2
  strategy:
    canary:
      steps:
      - setWeight: 20
      - pause: { duration: 30s }
      - analysis: { templates: [{ templateName: success-rate }] }
      - setWeight: 50
      - pause: { duration: 30s }
  selector: { matchLabels: { app: guestbook-ui } }
  template:
    metadata: { labels: { app: guestbook-ui } }
    spec:
      containers:
      - name: guestbook-ui
        image: gcr.io/heptio-images/ks-guestbook-demo:0.2
        ports: [{ containerPort: 80 }]
EOF
# 触发一次金丝雀：改镜像 tag 再 apply，然后观察步骤推进
# kubectl argo rollouts get rollout guestbook-rollout --watch -n guestbook
# （示例镜像无 5xx 指标时 Analysis 可能 NoData——NoData 视为失败是可配置项，
#   这里体验的是"门禁机制"本身；生产把 query 换成你的真实指标）
```

预期总耗时 12-18 分钟。第 3 步的自愈和第 6 步的门禁是两个"值回票价"的演示。

## 24.4 生产案例：公开复盘与事故模式

案例一（公开可查证）：ArgoCD 的一个经典安全研究线：2024 年披露的 CVE-2024-21633（ArgoCD CLI 本地提权到 root）等，以及历史上多次 "ArgoCD 实例暴露公网 + 默认密码" 导致的入侵报告（安全厂商 Shodan 扫描报告多次点名暴露的 ArgoCD/Argo 面板）。教训：**GitOps 控制器成为新的最高价值目标**——它对全集群有写权限。加固清单：不暴露公网、初始密码立即换+禁用 admin、RBAC 按 project 隔离、repo 凭证最小化。

案例二（行业通病，模式）："Secret 怎么进 Git？"GitOps 的第一天就会撞上这个问题。明文进 Git 违反一切安全直觉。主流解法三条：Sealed Secrets（公钥加密后可进 Git）、External Secrets Operator（Git 里只存引用，运行时从 Vault/云 KMS 拉取）、SOPS+age（文件级加密）。选型倾向：**新集群直接 ESO**，密钥永不落 Git 仓库与 etcd 双重收益（串联第 20 章 L4）。

案例三（公开模式）：金丝雀门禁的"指标陷阱"。常见翻车：canary 基线期太短指标未就绪 → NoData →（默认配置下）门禁形同虚设或全量失败。Argo Rollouts 官方文档专门讨论 NoData 语义。工程结论：门禁指标要"预热数据+定义 NoData 行为+失败上限"，上线前用混沌/压测演练门禁真的会拦——**没演练过的自动回滚等于不存在**。

## 24.5 本章面试题

1. GitOps 四原则？（声明式/版本化不可变/自动拉取/持续调和）
2. CI/CD 和 GitOps 的边界？（CI 产出镜像与配置提交；GitOps 只负责 Git→集群的调和，Push vs Pull 的安全含义）
3. selfHeal 不开会怎样？（kubectl 手改存活，配置漂移，GitOps 名存实亡）
4. Canary 的 Analysis 门禁怎么设计才可信？（真实指标+预热+NoData 语义+失败上限+事前演练）
5. GitOps 下 Secret 的三种方案与取舍？（Sealed Secrets/ESO/SOPS；ESO 密钥不落 Git）
6. ArgoCD 与 Flux 怎么选？（UI 与生态 vs 精简内核；团队习惯定，别都上）

## 24.6 自测清单

- [ ] 能背 GitOps 四原则并解释 Pull 模式的安全收益
- [ ] lab 亲眼看到 selfHeal 改回手改副本数
- [ ] 能写出带 Analysis 门禁的 Rollout YAML
- [ ] 有 ArgoCD 加固清单（不暴露/换密钥/RBAC）
- [ ] 能给团队设计 Secret 进 Git 的方案并说清取舍

> 调研粮备注：lab 的 Argo Rollouts Analysis 步依赖第 12 章 Prometheus 栈与真实指标，示例指标可能 NoData，已在文中标注；案例为公开 CVE/扫描报告与社区文档模式。
