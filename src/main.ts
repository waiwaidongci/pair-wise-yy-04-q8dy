import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createVuetify } from 'vuetify'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import App from './App.vue'
import router from './router'
import './assets/main.css'

const vuetify = createVuetify({
  theme: {
    defaultTheme: 'light',
    themes: {
      light: {
        colors: {
          primary: '#2563eb',
          secondary: '#0891b2',
          surface: '#ffffff',
          background: '#eef2f7',
        },
      },
    },
  },
  defaults: {
    VBtn: { rounded: 'sm' },
    VTextField: { variant: 'outlined', density: 'compact' },
  },
})

createApp(App).use(createPinia()).use(router).use(vuetify).mount('#app')
