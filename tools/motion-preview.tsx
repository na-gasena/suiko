import { createRoot } from 'react-dom/client';
import MotionStudy from '../app/motion-study';

const container = document.getElementById('suiko-motion-preview');
if (container) createRoot(container).render(<MotionStudy />);
