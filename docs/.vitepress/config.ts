import { existsSync } from "node:fs";
import { defineConfig } from "vitepress";

const GITHUB_URL = "https://github.com/ibrahimhnif/opensiel";
const DEMO_URL = "https://opensiel.liostech.id";
const base = process.env.DOCS_BASE ?? "/docs/";
const hasGit = existsSync(".git");

export default defineConfig({
  base,
  title: "opensiel",
  titleTemplate: ":title · opensiel docs",
  description:
    "Documentation for opensiel, a self-hosted secrets manager with approvals, versioning, SSO, dynamic credentials, and audit logs.",
  lang: "en-US",
  appearance: false,
  cleanUrls: true,
  lastUpdated: hasGit,
  ignoreDeadLinks: [/^http:\/\/localhost/, /^http:\/\/127\.0\.0\.1/],
  srcExclude: ["README.md"],
  head: [
    ["link", { rel: "icon", href: `${base}logo.svg` }],
    ["meta", { name: "theme-color", content: "#0c0f12" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "opensiel documentation" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Self-hosted secrets manager without the paywall: approvals, versioning, SSO, dynamic credentials, webhooks, KMS.",
      },
    ],
    ["meta", { property: "og:image", content: `${base}og.png` }],
  ],
  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "opensiel",
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "Use cases", link: "/use-cases" },
      { text: "CI/CD", link: "/ci-cd" },
      { text: "Kubernetes", link: "/kubernetes" },
      { text: "Live demo", link: DEMO_URL },
    ],
    sidebar: {
      "/": [
        {
          text: "Start",
          items: [
            { text: "Getting started", link: "/getting-started" },
            { text: "Local development", link: "/local-development" },
            { text: "Configuration", link: "/configuration" },
          ],
        },
        {
          text: "Integrate",
          items: [
            { text: "CLI", link: "/cli" },
            { text: "SDK", link: "/sdk" },
            { text: "Use cases", link: "/use-cases" },
            { text: "CI/CD", link: "/ci-cd" },
            { text: "Kubernetes", link: "/kubernetes" },
          ],
        },
        {
          text: "Operate",
          items: [
            { text: "Operations", link: "/operations" },
            { text: "Troubleshooting", link: "/troubleshooting" },
            { text: "FAQ", link: "/faq" },
          ],
        },
        {
          text: "Reference",
          items: [{ text: "Architecture", link: "/architecture" }],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: GITHUB_URL }],
    search: {
      provider: "local",
    },
    editLink: {
      pattern: `${GITHUB_URL}/edit/main/docs/:path`,
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "MIT licensed · secrets without the paywall",
      copyright: `© ${new Date().getFullYear()} opensiel contributors`,
    },
    outline: { level: [2, 3], label: "On this page" },
    docFooter: { prev: "Previous", next: "Next" },
    lastUpdated: { text: "Updated" },
    returnToTopLabel: "Back to top",
    sidebarMenuLabel: "Menu",
    externalLinkIcon: true,
  },
});
