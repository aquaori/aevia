import { createApp } from "vue";
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import "vue-sonner/style.css";
import "./style.css";
import App from "./App.vue";
import router from "./router";
import { labEnabled, labMark } from "./instrumentation/labMarks";
import { LAB_MARK_APP_BOOT, LAB_MARK_LAB_SENTINEL } from "./instrumentation/labMarkNames";

const app = createApp(App);

// The lab EditorPlugin is registered in RoomView, where the live
// WhiteboardSession instance is composed; main.ts only marks app boot here.
if (labEnabled()) {
	labMark(LAB_MARK_APP_BOOT, { mode: import.meta.env.MODE });
}

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

if (labEnabled()) {
	labMark(LAB_MARK_LAB_SENTINEL);
}
