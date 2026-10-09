// Turns the policy source into the public text: removes author notes and the pre-publishing box,
// and keeps an optional clause only when its feature is switched on.
//   inline:  [▣{gps} and location]   -> " and location" or nothing
//   line:    | ▣{idv} ... |  or  ▣{gps} **Live trip location.** ...  -> whole line kept or dropped
//   "▣{!gps}" means "only while gps is off"; "▣{gps|sms}" means "if either is on".
export function renderPolicySource(md, features) {
  const on = (expr) => expr.split('|').some((f) => (f.startsWith('!') ? !features[f.slice(1)] : !!features[f]));
  return md
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^> \*\*Before publishing[\s\S]*?(?=\n(?!>))/m, '')
    .replace(/\[▣\{([^}]+)\}([^\]]*)\]/g, (_, e, text) => (on(e) ? text : ''))
    .split('\n')
    .filter((line) => { const m = /▣\{([^}]+)\}/.exec(line); return !m || on(m[1]); })
    .map((line) => line.replace(/▣\{[^}]+\}\s?/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}
