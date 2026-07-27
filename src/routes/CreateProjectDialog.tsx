import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

import { useAuth } from '@/lib/auth-context'
import { createProject } from '@/lib/projects'
import { deriveProjectKey, PROJECT_KEY_PATTERN } from '@/lib/project-key'
import type { Project } from '@/lib/domain'
import { Input } from '@/components/ui/input'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { CreateDialog } from './CreateDialog'

const CreateProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Project name is required')
    .max(80, 'Keep the name to 80 characters or fewer'),
  key: z
    .string()
    .regex(
      PROJECT_KEY_PATTERN,
      'Key must be 2–4 characters: start with a letter, uppercase letters and digits only',
    ),
})
type CreateProjectValues = z.infer<typeof CreateProjectSchema>

/**
 * Create-project dialog. The key auto-suggests from the name (via `deriveProjectKey`)
 * until the user edits the key themselves — after that the suggestion stops, so we
 * never overwrite a deliberate choice. Both edges validate: zod here, the
 * `projects_key_format` / `projects_owner_key_unique` constraints in the database,
 * whose unique violation surfaces as a field error rather than a crash.
 */
export function CreateProjectDialog({ onCreated }: { onCreated?: (project: Project) => void }) {
  const { user } = useAuth()
  const [keyEdited, setKeyEdited] = useState(false)

  const form = useForm<CreateProjectValues>({
    resolver: zodResolver(CreateProjectSchema),
    defaultValues: { name: '', key: '' },
  })

  async function onSubmit(values: CreateProjectValues, close: () => void) {
    if (!user) {
      form.setError('root', { message: 'You must be signed in to create a project.' })
      return
    }

    const result = await createProject({
      ownerId: user.id,
      name: values.name.trim(),
      key: values.key,
    })

    if (!result.ok) {
      if (result.error === 'duplicate_key') {
        form.setError('key', { message: 'You already have a project with this key.' })
      } else {
        form.setError('root', { message: 'Something went wrong. Please try again.' })
      }
      return
    }

    onCreated?.(result.project)
    close()
  }

  return (
    <CreateDialog
      trigger="New project"
      title="Create a project"
      description="Name it, and we’ll suggest a key you can edit."
      submitLabel="Create project"
      form={form}
      onSubmit={onSubmit}
      // Safe if the shell ever calls this twice on a double close: setting an already-false
      // state is a no-op, same as the old handleOpenChange's identical assignment.
      onClosed={() => setKeyEdited(false)}
    >
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl>
              <Input
                placeholder="Sprintboard"
                {...field}
                onChange={(e) => {
                  field.onChange(e)
                  if (!keyEdited) {
                    form.setValue('key', deriveProjectKey(e.target.value), {
                      shouldValidate: form.formState.isSubmitted,
                    })
                  }
                }}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="key"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Key</FormLabel>
            <FormControl>
              <Input
                placeholder="SPR"
                {...field}
                onChange={(e) => {
                  setKeyEdited(true)
                  field.onChange(e.target.value.toUpperCase())
                }}
              />
            </FormControl>
            <FormDescription>Prefixes ticket IDs, e.g. SPR-1.</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </CreateDialog>
  )
}
