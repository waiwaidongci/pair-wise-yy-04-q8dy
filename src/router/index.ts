import { createRouter, createWebHashHistory } from 'vue-router'
import SheetView from '../views/SheetView.vue'

export default createRouter({
  history: createWebHashHistory(),
  routes: [{ path: '/', component: SheetView }, { path: '/:pathMatch(.*)*', component: SheetView }],
})
