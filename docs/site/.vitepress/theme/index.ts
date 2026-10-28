// The default theme plus a few lines of CSS (light/dark screenshots) and the promo video under the home hero.
import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import HeroVideo from "./HeroVideo.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "home-hero-after": () => h(HeroVideo) }),
};
