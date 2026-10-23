import { createApp } from 'vue';
import App from './App.vue';
// 共享视觉基线：token + 原生控件基准形态（与推流端同一份，避免两套皮肤）
import '../../../packages/shared/styles/theme.css';
import './styles/app.css';

createApp(App).mount('#app');
