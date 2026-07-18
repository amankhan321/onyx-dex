"use client";

import { motion, useReducedMotion, type Variants } from "framer-motion";
import type { ReactNode } from "react";

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Stagger — reveals children in sequence.
 *
 * `whenInView` (default true) switches the trigger from on-mount to
 * on-scroll-into-view: it fires once, when the block is ~120px into the
 * viewport, and never re-hides on scroll-up. Set it false for above-the-fold
 * blocks (the hero) that should animate immediately on load.
 */
export function Stagger({
  children,
  gap = 0.08,
  className,
  whenInView = true,
}: {
  children: ReactNode;
  gap?: number;
  className?: string;
  whenInView?: boolean;
}) {
  const still = useReducedMotion();
  const trigger = whenInView
    ? { whileInView: "show", viewport: { once: true, margin: "-120px" } as const }
    : { animate: "show" as const };

  return (
    <motion.div
      className={className}
      initial={still ? false : "hidden"}
      {...trigger}
      variants={{ show: { transition: { staggerChildren: still ? 0 : gap } } }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Rise — one element fading up from +y. Drop inside a Stagger and it inherits
 * the cascade; use standalone with `solo` to reveal on its own scroll trigger.
 */
export function Rise({
  children,
  className,
  y = 44,
  solo = false,
}: {
  children: ReactNode;
  className?: string;
  y?: number;
  solo?: boolean;
}) {
  const still = useReducedMotion();

  const variants: Variants = {
    hidden: { opacity: 0, y: still ? 0 : y },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.45, ease: EASE },
    },
  };

  if (solo) {
    return (
      <motion.div
        className={className}
        initial={still ? false : "hidden"}
        whileInView="show"
        viewport={{ once: true, margin: "-100px" }}
        variants={variants}
      >
        {children}
      </motion.div>
    );
  }

  return (
    <motion.div className={className} variants={variants}>
      {children}
    </motion.div>
  );
}

/**
 * Float — gentle infinite up-down drift for decorative "living" elements.
 * Purely aesthetic; fully disabled under reduced-motion.
 */
export function Float({
  children,
  className,
  distance = 6,
  duration = 6,
}: {
  children: ReactNode;
  className?: string;
  distance?: number;
  duration?: number;
}) {
  const still = useReducedMotion();
  if (still) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      animate={{ y: [0, -distance, 0] }}
      transition={{ duration, repeat: Infinity, ease: "easeInOut" }}
    >
      {children}
    </motion.div>
  );
}


/**
 * SlideIn — premium side-entrance. Content drifts in from the left or right on a
 * long, silky curve and settles into place, triggered once on scroll-in.
 */
export function SlideIn({
  children,
  from = "left",
  className,
  distance = 90,
  delay = 0,
}: {
  children: ReactNode;
  from?: "left" | "right";
  className?: string;
  distance?: number;
  delay?: number;
}) {
  const still = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={still ? false : { opacity: 0, x: from === "left" ? -distance : distance }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay }}
    >
      {children}
    </motion.div>
  );
}
