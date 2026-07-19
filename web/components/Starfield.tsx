"use client";

import { useEffect, useRef } from "react";

/**
 * Starfield Close — adapted from Nick's Three.js spec: 4200 additive shader
 * points in mint/jade/bone tints drifting down an endless tunnel, per-star
 * twinkle, slow barrel roll, cursor repel, scroll-driven dive. Adaptations for
 * a live DEX: fixed background canvas (no scroll-host hijack; window scroll
 * drives the dive) and no triple-composer bloom (additive points already read
 * as glow; three full-res passes would hurt weak GPUs). Off for reduced-motion
 * and touch devices.
 */
export function Starfield() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    let raf = 0;
    let dispose = () => {};

    (async () => {
      const THREE = await import("three");
      const canvas = ref.current;
      if (!canvas) return;

      const C = {
        colorA: "#aef6cf", colorB: "#5fe6a0", colorC: "#eafff2",
        pointSize: 50, brightness: 1.85, opacity: 2,
        drift: 2.35, twinkle: 1, spin: 0.03,
        repelRadius: 5, repelStrength: 0.35,
        scrollPush: 8, scrollDrift: 6, scrollSpin: 0.1, parallax: 0.6,
        count: 4200, depth: 30,
      };
      const hex = (h: string) => new THREE.Color(h);

      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(innerWidth, innerHeight, false);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 80);
      camera.position.set(0, 0, 5);

      const pos = new Float32Array(C.count * 3);
      const pal = new Float32Array(C.count);
      const bright = new Float32Array(C.count);
      const scl = new Float32Array(C.count);
      const phase = new Float32Array(C.count);
      for (let i = 0; i < C.count; i++) {
        pos[i * 3] = (Math.random() - 0.5) * 24;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 16;
        pos[i * 3 + 2] = (Math.random() - 0.5) * C.depth;
        pal[i] = Math.floor(Math.random() * 3);
        bright[i] = 0.7 + Math.random() * 0.6;
        scl[i] = 0.5 + Math.pow(Math.random(), 1.4) * 2.5;
        phase[i] = Math.random();
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("aPalette", new THREE.Float32BufferAttribute(pal, 1));
      geo.setAttribute("aBright", new THREE.Float32BufferAttribute(bright, 1));
      geo.setAttribute("aScale", new THREE.Float32BufferAttribute(scl, 1));
      geo.setAttribute("aPhase", new THREE.Float32BufferAttribute(phase, 1));

      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 }, uSize: { value: C.pointSize }, uOpacity: { value: 0 },
          uDrift: { value: 0 }, uDepth: { value: C.depth }, uTwinkle: { value: C.twinkle },
          uCursor: { value: new THREE.Vector3() }, uRepelRadius: { value: C.repelRadius },
          uRepelStrength: { value: C.repelStrength }, uActivity: { value: 0 },
          uColorA: { value: hex(C.colorA) }, uColorB: { value: hex(C.colorB) },
          uColorC: { value: hex(C.colorC) }, uBrightness: { value: C.brightness },
        },
        vertexShader: `
          uniform float uTime,uSize,uDrift,uDepth,uTwinkle,uRepelRadius,uRepelStrength,uActivity;
          uniform vec3 uCursor,uColorA,uColorB,uColorC;
          attribute float aScale,aPhase,aPalette,aBright;
          varying vec3 vColor; varying float vTwinkle;
          void main(){
            vec3 pos=position;
            pos.z=mod(pos.z+uDrift+(uDepth*0.5),uDepth)-(uDepth*0.5);
            float tw=sin(uTime*1.6+aPhase*6.2831);
            vTwinkle=(1.0-uTwinkle)+uTwinkle*(0.55+0.45*tw);
            vec4 mp=modelMatrix*vec4(pos,1.0);
            vec3 tp=mp.xyz-uCursor;
            float falloff=smoothstep(uRepelRadius,0.0,length(tp));
            mp.xyz+=normalize(tp+vec3(0.0001))*falloff*uRepelStrength*uActivity;
            vec4 vp=viewMatrix*mp;
            gl_Position=projectionMatrix*vp;
            gl_PointSize=uSize*aScale*(1.0/-vp.z);
            vec3 base=aPalette<0.5?uColorA:(aPalette<1.5?uColorB:uColorC);
            vColor=base*aBright;
          }`,
        fragmentShader: `
          uniform float uOpacity,uBrightness;
          varying vec3 vColor; varying float vTwinkle;
          void main(){
            vec2 uv=gl_PointCoord-0.5;
            float d=length(uv);
            if(d>0.5) discard;
            float s=pow(1.0-d*2.0,4.0);
            gl_FragColor=vec4(vColor*uBrightness*s*uOpacity*vTwinkle,s);
          }`,
      });
      const group = new THREE.Group();
      group.add(new THREE.Points(geo, mat));
      scene.add(group);

      let drift = 0, t0 = performance.now() / 1000;
      let scrollS = 0, mx = 0, my = 0, mxS = 0, myS = 0, activity = 0, lastMove = 0;
      const cursor = new THREE.Vector3();
      const appearStart = performance.now();

      const onMove = (e: PointerEvent) => {
        mx = (e.clientX / innerWidth) * 2 - 1;
        my = -((e.clientY / innerHeight) * 2 - 1);
        lastMove = performance.now();
      };
      addEventListener("pointermove", onMove, { passive: true });
      const onResize = () => {
        renderer.setSize(innerWidth, innerHeight, false);
        camera.aspect = innerWidth / innerHeight;
        camera.updateProjectionMatrix();
      };
      addEventListener("resize", onResize);

      const tick = () => {
        const t = performance.now() / 1000;
        const dt = Math.min(0.05, t - t0); t0 = t;
        const target = Math.min(1, scrollY / Math.max(1, document.body.scrollHeight - innerHeight));
        scrollS += (target - scrollS) * 0.06;
        mxS += (mx - mxS) * 0.06; myS += (my - myS) * 0.06;
        const idle = (performance.now() - lastMove) / 1000;
        activity += ((idle < 3 ? 1 : 0) - activity) * 0.06;
        drift += dt * (C.drift + scrollS * C.scrollDrift);
        cursor.set(mxS * 8, myS * 5, 0);
        mat.uniforms.uTime.value = t;
        mat.uniforms.uDrift.value = drift;
        mat.uniforms.uCursor.value.copy(cursor);
        mat.uniforms.uActivity.value = activity;
        mat.uniforms.uOpacity.value = Math.min(1, (performance.now() - appearStart - 300) / 1400) * C.opacity;
        group.rotation.z += dt * (C.spin + scrollS * C.scrollSpin);
        camera.position.set(mxS * C.parallax, myS * C.parallax, 5 - scrollS * C.scrollPush);
        camera.lookAt(mxS * 0.6, myS * 0.6, -10);
        renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      dispose = () => {
        removeEventListener("pointermove", onMove);
        removeEventListener("resize", onResize);
        geo.dispose(); mat.dispose(); renderer.dispose();
      };
    })();

    return () => { cancelAnimationFrame(raf); dispose(); };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0 h-full w-full"
      style={{ zIndex: -1 }}
    />
  );
}
