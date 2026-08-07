<template>
    <main>
        <h1>rammap — in-browser read mapping</h1>
        <p class="sub">Everything runs locally in WebAssembly. No file is uploaded anywhere.</p>
        <RammapPage />
    </main>
</template>

<script setup lang="ts">
// The worker is spawned once here, as sparrowhawk's App.vue does in mounted(), so the
// wasm module is compiled while the user is still choosing files.
import { onMounted } from "vue";
import { useStore } from "vuex";
import RammapPage from "@/components/pages/RammapPage.vue";

const store = useStore();
onMounted(() => store.dispatch("initWorker"));
</script>
