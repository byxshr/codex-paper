<template>
  <div v-if="checking" class="auth-shell" aria-live="polite">
    <div class="auth-card"><p>Checking local Viewer session…</p></div>
  </div>
  <slot v-else-if="authenticated" />
  <div v-else class="auth-shell">
    <form class="auth-card" @submit.prevent="submitPairing">
      <span class="auth-mark">◈</span>
      <h1>Pair with Codex Paper</h1>
      <p>Paste the one-time startup token printed in the terminal. It is sent only in the request body and is cleared after pairing.</p>
      <label for="pairing-token">Pairing token</label>
      <input
        id="pairing-token"
        ref="tokenInput"
        v-model="token"
        type="password"
        autocomplete="off"
        spellcheck="false"
        required
      >
      <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
      <button type="submit" :disabled="submitting || !token.trim()">
        {{ submitting ? 'Pairing…' : 'Pair Viewer' }}
      </button>
    </form>
  </div>
</template>

<script setup lang="ts">
const { authenticated, checking, loadSession, pair } = useSecuritySession()
const token = ref('')
const error = ref('')
const submitting = ref(false)
const tokenInput = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  await loadSession()
  if (!authenticated.value) nextTick(() => tokenInput.value?.focus())
})

const submitPairing = async () => {
  const pairingToken = token.value.trim()
  if (!pairingToken || submitting.value) return
  submitting.value = true
  error.value = ''
  try {
    await pair(pairingToken)
    token.value = ''
  } catch (cause: any) {
    token.value = ''
    error.value = cause.data?.statusMessage || cause.statusMessage || 'Pairing failed. Check the terminal token and try again.'
    nextTick(() => tokenInput.value?.focus())
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.auth-shell { min-height: 100vh; display: grid; place-items: center; padding: 2rem; background: #f6f4ef; color: #1f2937; }
.auth-card { width: min(430px, 100%); padding: 2.5rem; border: 1px solid #ddd7ca; border-radius: 18px; background: white; box-shadow: 0 20px 60px rgba(31, 41, 55, .08); }
.auth-mark { color: #8b5e34; font-size: 2rem; }
h1 { margin: .75rem 0; font: 700 2rem/1.1 Georgia, serif; }
p { line-height: 1.6; color: #5b6472; }
label { display: block; margin: 1.5rem 0 .5rem; font-weight: 600; }
input { box-sizing: border-box; width: 100%; padding: .8rem 1rem; border: 1px solid #b7bec8; border-radius: 8px; font: inherit; }
button { width: 100%; margin-top: 1rem; padding: .85rem; border: 0; border-radius: 8px; background: #1f2937; color: white; font: inherit; font-weight: 600; cursor: pointer; }
button:disabled { opacity: .55; cursor: wait; }
.auth-error { color: #b42318; }
</style>
