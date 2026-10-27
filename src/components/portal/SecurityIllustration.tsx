/** Original decorative illustration: a shield at the centre of radar rings and a node network. */
export function SecurityIllustration() {
  const nodes: Array<[number, number]> = [
    [70, 90], [330, 70], [360, 250], [60, 280], [200, 30], [210, 370], [120, 190], [290, 170],
  ];
  return (
    <svg viewBox="0 0 420 400" className="h-auto w-full" role="img" aria-label="Security monitoring illustration">
      <defs>
        <linearGradient id="si-shield" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2563eb" />
          <stop offset="1" stopColor="#14b8a6" />
        </linearGradient>
        <radialGradient id="si-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#3b82f6" stopOpacity="0.45" />
          <stop offset="1" stopColor="#3b82f6" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="210" cy="200" r="190" fill="url(#si-glow)" />
      {[70, 115, 160].map((r, i) => (
        <circle key={r} cx="210" cy="200" r={r} fill="none" stroke="#60a5fa" strokeOpacity={0.35 - i * 0.08} strokeDasharray="4 6" className="portal-ring" style={{ animationDelay: `${i * 0.8}s` }} />
      ))}
      <g className="portal-sweep" style={{ transformOrigin: "210px 200px" }}>
        <path d="M210 200 L210 40 A160 160 0 0 1 345 115 Z" fill="#14b8a6" fillOpacity="0.12" />
      </g>
      {nodes.map(([x, y], i) => (
        <g key={i}>
          <line x1="210" y1="200" x2={x} y2={y} stroke="#3b82f6" strokeOpacity="0.25" />
          <circle cx={x} cy={y} r="5" fill="#0b1530" stroke={i % 3 === 0 ? "#14b8a6" : "#60a5fa"} strokeWidth="2" className="portal-blink" style={{ animationDelay: `${i * 0.4}s` }} />
        </g>
      ))}
      <path d="M210 120 152 142v40c0 34 24 64 58 74 34-10 58-40 58-74v-40l-58-22Z" fill="url(#si-shield)" />
      <path d="m185 188 18 18 36-38" stroke="#fff" strokeWidth="9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
