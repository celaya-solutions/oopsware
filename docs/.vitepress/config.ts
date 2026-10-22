import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Oopsware",
  description:
    "A little curiosity. A lot of taking things apart. Oopsware by CSR.",
  lang: "en-US",
  base: "/rea/",
  srcExclude: ["readme/**"],
  themeConfig: {
    nav: [
      { text: "Get started", link: "/installation" },
      { text: "Reference", link: "/mcp-contracts" },
      { text: "Roadmap", link: "/roadmap" },
    ],
    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Installation and setup", link: "/installation" },
          { text: "Client configuration", link: "/client-configuration" },
          { text: "CLI and Evidence", link: "/cli" },
          { text: "Agent prompts", link: "/mcp-prompts" },
          { text: "Roadmap", link: "/roadmap" },
        ],
      },
      {
        text: "Investigation guides",
        items: [
          { text: "Native binaries", link: "/native-investigation" },
          { text: "Go build metadata", link: "/go-binaries" },
          { text: "IL2CPP metadata", link: "/il2cpp-metadata" },
          { text: "Model artifacts", link: "/model-artifacts" },
          { text: "Rust dependencies", link: "/rust-binaries" },
          {
            text: "JavaScript and Electron",
            link: "/javascript-artifact-reconstruction",
          },
          {
            text: "JavaScript workflows",
            link: "/javascript-application-workflows",
          },
          { text: "Browser observation", link: "/browser-observation" },
          {
            text: "Web network captures",
            link: "/web-network-captures",
          },
          { text: "Agent environments", link: "/agent-environments" },
          { text: "Electron observation", link: "/electron-observation" },
          { text: "Electron fuses", link: "/electron-fuses" },
          { text: "Process capture", link: "/process-capture" },
          { text: ".NET assemblies", link: "/managed-code-analysis" },
          { text: "Android applications", link: "/android-analysis" },
          { text: "Apple applications", link: "/apple-application-analysis" },
          { text: "Desktop installations", link: "/desktop-applications" },
          { text: "Firmware", link: "/firmware-analysis" },
          { text: "SQLite databases", link: "/sqlite-databases" },
          { text: "Packet captures", link: "/packet-captures" },
          { text: "Signal recordings", link: "/signal-recordings" },
        ],
      },
      {
        text: "Provider guides",
        collapsed: true,
        items: [
          { text: "IDA", link: "/ida-provider" },
          { text: "Kuna", link: "/kuna-provider" },
          { text: "Ghidra on Windows", link: "/windows-ghidra-p0" },
          { text: "Ghidra DOS analysis", link: "/ghidra-dos" },
          { text: "Ghidra raw binary", link: "/raw-binary" },
          { text: "Ghidra NativeAOT", link: "/ghidra-nativeaot" },
          { text: "Ghidra PowerPC", link: "/ghidra-ppc" },
          { text: "Ghidra semantics", link: "/ghidra-provider" },
        ],
      },
      {
        text: "Reference and development",
        collapsed: true,
        items: [
          { text: "MCP contracts", link: "/mcp-contracts" },
          { text: "Tool design", link: "/tool-design" },
          { text: "Testing", link: "/testing" },
          { text: "Client verification", link: "/client-verification" },
          {
            text: "Reconstruction readiness",
            link: "/reconstruction-readiness",
          },
          { text: "Releasing", link: "/releasing" },
        ],
      },
    ],
    search: { provider: "local" },
    socialLinks: [
      { icon: "github", link: "https://github.com/celaya-solutions/oopsware" },
    ],
    editLink: {
      pattern:
        "https://github.com/celaya-solutions/oopsware/edit/main/docs/:path",
    },
    footer: {
      message:
        "New CSR work: PolyForm Noncommercial. Original REA work: MIT. See LICENSE and CREDITS.",
      copyright: "Oopsware · Celaya Solutions / CSR",
    },
  },
});
