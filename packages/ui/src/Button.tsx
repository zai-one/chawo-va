import type { ButtonHTMLAttributes } from 'react';
import { cx } from './cx';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary: the one main action of a block; link: a quiet text button. */
  variant?: 'primary' | 'link';
}

export function Button({ variant, className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={cx(variant, className)} {...rest} />;
}
