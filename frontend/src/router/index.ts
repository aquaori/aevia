import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import RoomView from '../views/RoomView.vue'
import InviteView from '../views/InviteView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView
    },
    {
      path: '/invite/:token',
      name: 'invite',
      component: InviteView
    },
    {
      path: '/room',
      name: 'room',
      component: RoomView
    }
  ]
})

export default router
