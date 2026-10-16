import { toast } from 'sonner';


export function toastError(title, options) {
  return toast.error(title, { duration: Infinity, closeButton: true, ...options });
}
