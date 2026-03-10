import { runApp, handleFatalError } from './src/app.js';

runApp().catch(handleFatalError);

