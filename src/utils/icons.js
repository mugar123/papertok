import { Folder, Star, Microscope, FlaskConical, BookOpen, Target, Lightbulb, Dna, Atom, Flame, Heart } from 'lucide-react';

export const ICONS = {
  Folder, Star, Microscope, FlaskConical, BookOpen, Target, Lightbulb, Dna, Atom, Flame, Heart
};

export const getIcon = (nameOrEmoji) => {
  if (ICONS[nameOrEmoji]) return ICONS[nameOrEmoji];
  
  // Backwards compatibility with emojis already in database
  const emojiMap = {
    '📂': Folder, '⭐': Star, '🔬': Microscope, '🧪': FlaskConical, 
    '📚': BookOpen, '🎯': Target, '💡': Lightbulb, '🧬': Dna, 
    '⚛️': Atom, '🔥': Flame, '❤️': Heart
  };
  return emojiMap[nameOrEmoji] || Folder;
};

export const AVAILABLE_ICONS = ['Folder', 'Star', 'Microscope', 'FlaskConical', 'BookOpen', 'Target', 'Lightbulb', 'Dna', 'Atom', 'Flame'];
