import { createApp } from "vue";
import App from "./App.vue";
import store from "./store";
import "./assets/app.css";

const app = createApp(App).use(store);
// Test hook: lets the headless browser suite drive real runs through the store.
(window as unknown as { __store: typeof store }).__store = store;
app.mount("#app");
