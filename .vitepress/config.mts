import { defineConfig } from 'vitepress'

const chapters = Array.from({ length: 30 }, (_, i) => String(i + 1).padStart(2, '0'))

function chapterTitle(file) {
  return file.replace(/^\d+-/, '').replace(/\.md$/, '')
}

// 读目录文件交给 build 期 node 处理
import fs from 'node:fs'
const files = fs.readdirSync('.').filter(f => /^\d{2}-.*\.md$/.test(f)).sort()

export default defineConfig({
  ignoreDeadLinks: true,
  lang: 'zh-CN',
  title: 'K8s 30 章实战课',
  description: '从心智模型到生产级 AI 推理平台：写给高级开发者的 Kubernetes 完整学习路径。',
  head: [['meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }]],
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: 'GitHub', link: 'https://github.com/archorfight/k8s-course' },
    ],
    sidebar: [
      {
        text: '开始',
        items: [{ text: '课程导读', link: '/intro' }],
      },
      {
        text: '第 1 部分 · 心智模型与核心对象',
        items: files.slice(0, 10).map(f => ({ text: chapterTitle(f), link: '/' + f.replace('.md', '') })),
      },
      {
        text: '第 2 部分 · 进阶实战',
        items: files.slice(10, 20).map(f => ({ text: chapterTitle(f), link: '/' + f.replace('.md', '') })),
      },
      {
        text: '第 3 部分 · 生产、规模与毕业',
        items: files.slice(20).map(f => ({ text: chapterTitle(f), link: '/' + f.replace('.md', '') })),
      },
    ],
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一章', next: '下一章' },
    search: {
      provider: 'local',
      options: { translations: { button: { buttonText: '搜索', buttonAriaLabel: '搜索' }, modal: { noResultsText: '没有结果' } } },
    },
    darkModeSwitchLabel: '外观',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
  },
})
