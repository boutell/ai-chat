import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import { createVuetify } from 'vuetify';

export default createVuetify({
  theme: {
    defaultTheme: 'dark',
    themes: {
      dark: {
        colors: {
          primary: '#7C4DFF',
          secondary: '#448AFF',
          surface: '#1E1E1E',
          background: '#121212'
        }
      }
    }
  }
});
