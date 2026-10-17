import { toast } from 'sonner';


export function toastError(title: Parameters<typeof toast.error>[0], options?: Parameters<typeof toast.error>[1]) {
  return toast.error(title, { duration: Infinity, closeButton: true, ...options });
}
