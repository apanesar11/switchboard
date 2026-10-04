// Tremor Toast [v1.0.0]
"use client"
import React from "react"
import * as ToastPrimitives from "@radix-ui/react-toast"
import {
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiErrorWarningFill,
  RiInformationFill,
  RiLoader2Fill,
} from "@remixicon/react"

import { cx } from "@/lib/utils"

const ToastProvider = ToastPrimitives.Provider
ToastProvider.displayName = "ToastProvider"

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ className, ...props }, forwardedRef) => (
  <ToastPrimitives.Viewport
    ref={forwardedRef}
    className={cx(
      "fixed right-0 top-0 z-[9999] m-0 flex w-full max-w-[100vw] list-none flex-col gap-2 p-[var(--viewport-padding)] [--viewport-padding:_15px] sm:max-w-md sm:gap-4",
      className,
    )}
    {...props}
  />
))

ToastViewport.displayName = "ToastViewport"

interface ActionProps {
  label: string
  altText: string
  onClick: () => void | Promise<void>
}

interface ToastProps
  extends React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> {
  variant?: "info" | "success" | "warning" | "error" | "loading"
  title?: string
  description?: string
  action?: ActionProps
  disableDismiss?: boolean
}

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  ToastProps
>(
  (
    {
      className,
      variant,
      title,
      description,
      action,
      disableDismiss = false,
      ...props
    }: ToastProps,
    forwardedRef,
  ) => {
    let Icon: React.ReactNode
    switch (variant) {
      case "success":
        Icon = (
          <RiCheckboxCircleFill
            className="size-5 shrink-0 text-emerald-600 dark:text-emerald-500"
            aria-hidden="true"
          />
        )
        break
      case "warning":
        Icon = (
          <RiErrorWarningFill
            className="size-5 shrink-0 text-amber-500 dark:text-amber-500"
            aria-hidden="true"
          />
        )
        break
      case "error":
        Icon = (
          <RiCloseCircleFill
            className="size-5 shrink-0 text-red-600 dark:text-red-500"
            aria-hidden="true"
          />
        )
        break
      case "loading":
        Icon = (
          <RiLoader2Fill
            className="size-5 shrink-0 animate-spin text-gray-600 dark:text-gray-500"
            aria-hidden="true"
          />
        )
        break
      default:
        Icon = (
          <RiInformationFill
            className="size-5 shrink-0 text-blue-500 dark:text-blue-500"
            aria-hidden="true"
          />
        )
        break
    }

    return (
      <ToastPrimitives.Root
        ref={forwardedRef}
        className={cx(
          // base
          "flex h-fit min-h-16 w-full overflow-hidden rounded-md border shadow-lg shadow-black/5",
          // background color
          "bg-white dark:bg-[#090E1A]",
          // border color
          "border-gray-200 dark:border-gray-800",
          // swipe
          "data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none",
          // transition
          "data-[state=open]:animate-slide-left-and-fade",
          "data-[state=closed]:animate-hide",
          className,
        )}
        tremor-id="tremor-raw"
        {...props}
      >
        <div
          className={cx(
            // base
            "flex flex-1 items-start gap-3 p-4",
            // border
            !disableDismiss || action
              ? "border-r border-gray-200 dark:border-gray-800"
              : "",
          )}
        >
          {Icon}
          <div className="flex flex-col gap-1">
            {title && (
              <ToastPrimitives.Title className="text-sm font-semibold text-gray-900 dark:text-gray-50">
                {title}
              </ToastPrimitives.Title>
            )}
            {description && (
              <ToastPrimitives.Description className="text-sm text-gray-600 dark:text-gray-400">
                {description}
              </ToastPrimitives.Description>
            )}
          </div>
        </div>
        <div className="flex flex-col">
          {action && (
            <>
              <ToastPrimitives.Action
                altText={action.altText}
                className={cx(
                  // base
                  "flex flex-1 items-center justify-center px-6 text-sm font-semibold transition-colors",
                  // hover
                  "hover:bg-gray-50 dark:hover:bg-gray-900/30",
                  // text color
                  "text-gray-800 dark:text-gray-100",
                  // active
                  "active:bg-gray-100 dark:active:bg-gray-800",
                  {
                    "text-red-600 dark:text-red-500": variant === "error",
                  },
                )}
                onClick={(event) => {
                  event.preventDefault()
                  action.onClick()
                }}
                type="button"
              >
                {action.label}
              </ToastPrimitives.Action>
              <div className="h-px w-full bg-gray-200 dark:bg-gray-800" />
            </>
          )}
          {!disableDismiss && (
            <ToastPrimitives.Close
              className={cx(
                // base
                "flex flex-1 items-center justify-center px-6 text-sm transition-colors",
                // text color
                "text-gray-600 dark:text-gray-400",
                // hover
                "hover:bg-gray-50 dark:hover:bg-gray-900/30",
                // active
                "active:bg-gray-100",
                action ? "h-1/2" : "h-full",
              )}
              aria-label="Close"
            >
              Close
            </ToastPrimitives.Close>
          )}
        </div>
      </ToastPrimitives.Root>
    )
  },
)
Toast.displayName = "Toast"

// Toast state management
type ToastInput = {
  variant?: ToastProps["variant"]
  title?: string
  description?: string
  action?: ActionProps
  disableDismiss?: boolean
  duration?: number
}

type ToastState = ToastInput & { id: string; open: boolean }

let toastQueue: ToastState[] = []
let listeners: Array<(toasts: ToastState[]) => void> = []

function notifyListeners() {
  listeners.forEach((l) => l([...toastQueue]))
}

function toast(input: ToastInput) {
  const id = Math.random().toString(36).slice(2)
  toastQueue = [...toastQueue, { ...input, id, open: true }]
  notifyListeners()
}

function useToast() {
  const [toasts, setToasts] = React.useState<ToastState[]>([...toastQueue])

  React.useEffect(() => {
    listeners.push(setToasts)
    return () => {
      listeners = listeners.filter((l) => l !== setToasts)
    }
  }, [])

  const dismiss = (id: string) => {
    toastQueue = toastQueue.map((t) =>
      t.id === id ? { ...t, open: false } : t,
    )
    notifyListeners()
  }

  const remove = (id: string) => {
    toastQueue = toastQueue.filter((t) => t.id !== id)
    notifyListeners()
  }

  return { toasts, dismiss, remove }
}

function Toaster() {
  const { toasts, dismiss, remove } = useToast()

  return (
    <ToastProvider>
      {toasts.map(({ id, open, duration, ...props }) => (
        <Toast
          key={id}
          open={open}
          onOpenChange={(o) => {
            if (!o) dismiss(id)
          }}
          duration={duration}
          onAnimationEnd={() => {
            if (!open) remove(id)
          }}
          {...props}
        />
      ))}
      <ToastViewport />
    </ToastProvider>
  )
}

Toaster.displayName = "Toaster"

// Named re-exports from radix for completeness
const ToastTitle = ToastPrimitives.Title
const ToastDescription = ToastPrimitives.Description
const ToastAction = ToastPrimitives.Action
const ToastClose = ToastPrimitives.Close

type ToastActionElement = ActionProps

export {
  Toast,
  ToastProvider,
  ToastViewport,
  ToastTitle,
  ToastDescription,
  ToastAction,
  ToastClose,
  useToast,
  Toaster,
  toast,
  type ToastActionElement,
  type ToastProps,
}
