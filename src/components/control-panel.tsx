import React from 'react';

type ControlButtonVariant = 'primary' | 'secondary';

interface ControlSectionProps {
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  headerRight?: React.ReactNode;
  style?: React.CSSProperties;
}

interface ControlFieldProps {
  label?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

type ControlSelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  wrapperClassName?: string;
};

type ControlButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ControlButtonVariant;
};

export function ControlSection({
  title,
  children,
  className = '',
  contentClassName = '',
  headerRight,
  style,
}: ControlSectionProps) {
  const hasTitle = title !== undefined && title !== null && title !== '';
  const header = headerRight || hasTitle ? (
    <div className="ctrl-section-head">
      {hasTitle && <h2 className="ctrl-section-title">{title}</h2>}
      {headerRight}
    </div>
  ) : (
    null
  );

  return (
    <section className={`ctrl-section ${className}`.trim()} style={style}>
      {header}
      {contentClassName ? <div className={contentClassName}>{children}</div> : children}
    </section>
  );
}

export function ControlField({ label, children, className = '' }: ControlFieldProps) {
  return (
    <div className={`ctrl-field ${className}`.trim()}>
      {label && <label className="ctrl-field-label">{label}</label>}
      {children}
    </div>
  );
}

export function ControlSelect({ wrapperClassName = '', className = '', children, ...props }: ControlSelectProps) {
  return (
    <div className={`select-wrapper ${wrapperClassName}`.trim()}>
      <select className={`form-select ${className}`.trim()} {...props}>
        {children}
      </select>
    </div>
  );
}

export function ControlButton({
  variant = 'secondary',
  className = '',
  children,
  ...props
}: ControlButtonProps) {
  const variantClass = variant === 'primary' ? 'ctrl-button-2 ctrl-primary-action' : 'ctrl-button-1 ctrl-secondary-action';
  return (
    <button className={`${variantClass} ${className}`.trim()} {...props}>
      {children}
    </button>
  );
}
