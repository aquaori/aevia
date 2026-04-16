import { createApp } from "vue";
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import "vue-sonner/style.css";
import "./style.css";
import App from "./App.vue";
import router from "./router";

const app = createApp(App);

if (import.meta.env.DEV) {
	app.config.errorHandler = (err, _instance, info) => {
		console.error("[Vue Global Error]:", err);
		console.error("[Error Info]:", info);
	};

	window.addEventListener("error", (event) => {
		console.error("[Window Error]:", event.error || event.message);
	});

	window.addEventListener("unhandledrejection", (event) => {
		console.error("[Unhandled Promise Rejection]:", event.reason);
	});
}

const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);
app.use(pinia);
app.use(router);

app.mount("#app");
