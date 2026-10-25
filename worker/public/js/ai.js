// Settings > Use with AI: where the Connect buttons take you, and which way to connect comes first.
// The Windows app has the same in desktop/claude-desktop.ps1 (Get-AiOptions) and widget.ps1 ($script:AiLinks).

// The pages that open next to the copied link: Claude's Connectors settings (Add custom connector is there), ChatGPT's
// settings at Apps & Connectors. If ChatGPT does not know the place, it opens its start page, and the steps say where to go.
export const AI_LINKS = {
  claude: 'https://claude.ai/settings/connectors',
  chatgpt: 'https://chatgpt.com/#settings/Connectors',
  claudeDesktop: 'https://claude.ai/download',
};

/**
 * The ways to connect an AI, best first: 'link' (the link from the sync service: Claude and ChatGPT on the web, the
 * phone and the computer), 'desktop' (Claude Desktop on this computer: no sync needed), 'files' (an AI app that edits
 * the list files). With sync the link comes first; without it, on a computer, Claude Desktop. The phone and the web
 * have only the link.
 */
export function aiOptions({ sync, local }) {
  if (!local) return ['link'];
  return sync ? ['link', 'desktop', 'files'] : ['desktop', 'link', 'files'];
}
