import { motion } from 'framer-motion';

const variants = {
  initial: { opacity: 0, scale: 0.98, y: 10 },
  enter: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 1.02, y: -10 }
};

const transition = {
  type: "spring",
  stiffness: 300,
  damping: 30,
  mass: 1
};

export default function PageTransition({ children }) {
  return (
    <motion.div
      initial="initial"
      animate="enter"
      exit="exit"
      variants={variants}
      transition={transition}
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {children}
    </motion.div>
  );
}
