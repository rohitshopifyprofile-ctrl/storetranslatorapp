// Shared visual components for a consistent, polished look across the app.
// Pure client components — inline styles with CSS-var fallbacks so they render
// well in Shopify admin (light & dark).

export function AppHero({ eyebrow = "Translator", title, subtitle, emoji = "🌐", right = null }) {
  return (
    <div style={heroWrap}>
      <div style={heroIcon}>{emoji}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={heroEyebrow}>{eyebrow}</div>
        <div style={heroTitle}>{title}</div>
        {subtitle && <div style={heroSub}>{subtitle}</div>}
      </div>
      {right && <div style={{ flex: "none" }}>{right}</div>}
    </div>
  );
}

// A soft card surface for grouping content.
export function Card({ children, style }) {
  return <div style={{ ...cardStyle, ...style }}>{children}</div>;
}

// Colored pill badge.
export function Badge({ children, tone = "default" }) {
  const t = TONES[tone] || TONES.default;
  return <span style={{ ...badgeBase, background: t.bg, color: t.fg }}>{children}</span>;
}

// A vivid stat tile with a colored accent.
export function StatTile({ value, label, accent = "#00a08e", emoji }) {
  return (
    <div style={{ ...statTile, borderTop: `3px solid ${accent}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {emoji && <span style={{ fontSize: 18 }}>{emoji}</span>}
        <span style={{ fontSize: 30, fontWeight: 760, lineHeight: 1.1, color: accent }}>{value}</span>
      </div>
      <div style={statLabel}>{label}</div>
    </div>
  );
}

const TONES = {
  default: { bg: "var(--p-color-bg-surface-secondary,#f1f2f3)", fg: "var(--p-color-text-secondary,#6d7175)" },
  success: { bg: "#e7f4ee", fg: "#0b7a52" },
  info: { bg: "#e7f0fb", fg: "#1c5fbf" },
  warning: { bg: "#fdf2e2", fg: "#9a6a00" },
  critical: { bg: "#fdeceb", fg: "#b3271e" },
};

const heroWrap = {
  display: "flex", alignItems: "center", gap: 16, padding: "22px 24px",
  borderRadius: 16, marginBottom: 18, color: "#fff",
  background: "linear-gradient(120deg,#00735c 0%,#00a08e 55%,#17b6c9 100%)",
  boxShadow: "0 8px 24px rgba(0,128,96,.22)",
};
const heroIcon = {
  fontSize: 30, width: 58, height: 58, display: "grid", placeItems: "center",
  borderRadius: 14, background: "rgba(255,255,255,.18)", flex: "none",
};
const heroEyebrow = { fontSize: 12, fontWeight: 700, letterSpacing: ".09em", textTransform: "uppercase", opacity: .85 };
const heroTitle = { fontSize: 25, fontWeight: 770, lineHeight: 1.15, margin: "2px 0" };
const heroSub = { fontSize: 14, opacity: .92, maxWidth: 640, lineHeight: 1.45 };

const cardStyle = {
  background: "var(--p-color-bg-surface,#fff)", border: "1px solid var(--p-color-border,#e1e3e5)",
  borderRadius: 14, padding: 18,
};
const badgeBase = { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 650, padding: "3px 9px", borderRadius: 20, textTransform: "capitalize" };
const statTile = {
  background: "var(--p-color-bg-surface,#fff)", border: "1px solid var(--p-color-border,#e1e3e5)",
  borderRadius: 14, padding: "16px 18px", minWidth: 150, flex: 1,
};
const statLabel = { fontSize: 13, color: "var(--p-color-text-secondary,#6d7175)", marginTop: 6 };
