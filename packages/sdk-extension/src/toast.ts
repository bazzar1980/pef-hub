/** Minimal Shadow-DOM toast for adapters without a native screen-pop target. */
export function showToast(text: string, ms = 5000): void {
  const host = document.createElement('pef-hub-toast');
  host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 60px; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  box.setAttribute('role', 'status');
  box.style.cssText =
    'font: 400 13px/1.4 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif; background:#16202A; color:#FFFFFF; padding:10px 14px; border-radius:6px; max-width:320px; border-left:4px solid #1F5C7A;';
  box.textContent = text;
  root.appendChild(box);
  (document.body ?? document.documentElement).appendChild(host);
  setTimeout(() => host.remove(), ms);
}
