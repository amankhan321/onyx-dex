/**
 * The surface the whole app sits on.
 *
 * Two enormous, heavily-blurred light sources drifting on long cycles, plus a
 * grid that fades out toward the edges. Deliberately CSS keyframes rather than
 * Framer: this runs for the entire session on every page, and it should cost
 * the compositor nothing.
 *
 * The point is that the background is never flat. You shouldn't notice it —
 * you should notice when it's missing.
 */
export function Ambient() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ zIndex: -2 }}
    >
      <div
        className="blob"
        style={{
          top: "-22%",
          left: "-8%",
          width: 700,
          height: 700,
          background:
            "radial-gradient(circle, rgba(94,106,210,0.18) 0%, rgba(94,106,210,0.05) 45%, transparent 70%)",
          filter: "blur(70px)",
          animation: "float-a 18s ease-in-out infinite",
        }}
      />
      <div
        className="blob"
        style={{
          top: "-10%",
          right: "-12%",
          width: 600,
          height: 600,
          background:
            "radial-gradient(circle, rgba(46,211,167,0.14) 0%, rgba(46,211,167,0.04) 45%, transparent 70%)",
          filter: "blur(60px)",
          animation: "float-b 15s ease-in-out infinite",
        }}
      />

      <div
        className="absolute inset-0"
        style={{
          opacity: 0.03,
          backgroundImage:
            "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage:
            "radial-gradient(ellipse 70% 55% at 50% 30%, #000 20%, transparent 78%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 70% 55% at 50% 30%, #000 20%, transparent 78%)",
        }}
      />
    </div>
  );
}
