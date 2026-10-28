<script setup lang="ts">
// The promo video under the home hero: muted autoplay loop, with controls so a viewer can unmute.
// Visitors who ask for reduced motion get the poster and press play themselves.
import { onMounted, ref } from "vue";
import { withBase } from "vitepress";

const video = ref<HTMLVideoElement>();
onMounted(() => {
  const el = video.value;
  if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.play().catch(() => {});
});
</script>

<template>
  <div class="hero-video">
    <video
      ref="video"
      :src="withBase('/promo.mp4')"
      :poster="withBase('/promo-poster.jpg')"
      muted
      loop
      playsinline
      controls
      preload="metadata"
      width="1280"
      height="720"
      aria-label="claude-code-ui in 40 seconds: install, sessions, git graph, command palette, workers and phone notifications"
    ></video>
  </div>
</template>

<style scoped>
.hero-video {
  max-width: 1280px; /* the hero column (1152px) plus its 64px side padding */
  margin: 0 auto;
  padding: 0 24px 48px;
}
@media (min-width: 640px) {
  .hero-video { padding: 0 48px 64px; }
}
@media (min-width: 960px) {
  .hero-video { padding: 0 64px 64px; }
}
video {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  box-shadow: var(--vp-shadow-3);
  background: var(--vp-c-bg-soft);
}
</style>
