import './site.css';
import { applySiteConfig } from './common.js';

applySiteConfig();

const style = document.createElement('style');
style.textContent = `
.legal { max-width: 760px; padding-block: 56px 88px; }
.legal h1 { font-size: clamp(30px, 4vw, 42px); margin-bottom: 18px; }
.legal h2 { font-size: 21px; margin: 32px 0 8px; }
.legal p { color: var(--ink-2); }
.legal-note { background: #fbf3d6; border-left: 4px solid var(--survey); padding: 12px 16px; border-radius: 6px; }
.site-header .btn { margin-inline-start: auto; }
`;
document.head.append(style);
