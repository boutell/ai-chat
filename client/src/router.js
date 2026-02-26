import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  {
    path: '/',
    name: 'home',
    component: () => import('./App.vue'),
  }
];

export default createRouter({
  history: createWebHistory(),
  routes
});
