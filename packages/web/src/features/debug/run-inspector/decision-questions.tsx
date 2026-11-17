import type { DecisionQuestionRecord, RunInspection } from '@pluribus/protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Verbatim } from '../parts'

/**
 * Item 5's questions: each card shows the question as asked. Where the
 * decision recorded the request it was sent in, a button opens exactly what
 * was sent in a dialog, so a long state does not crowd the side panel: the
 * question and the request's whole state text.
 */
export function DecisionQuestions({ routing }: { routing: NonNullable<RunInspection['routing']> }) {
  const { decision, requests } = routing
  if (decision.questions.length === 0) return null
  return (
    <details className="mt-1.5 text-xs">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        Questions put to the decision model ({decision.questions.length})
      </summary>
      {decision.source === 'decision-model' && !decision.requests ? (
        <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground" data-testid="state-not-recorded">
          Recorded before Pluribus kept the state each request sent: only the questions are shown.
        </p>
      ) : null}
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {decision.questions.map((question, i) => {
          const state = question.request === undefined ? undefined : requests[question.request]
          return (
            <li key={`${question.id}-${i}`} className="rounded-md border border-border bg-background px-2.5 py-2 leading-relaxed" data-question={question.id}>
              <p>{question.instructions}</p>
              <p className="mt-1 text-muted-foreground">
                <span className="font-mono text-2xs">{question.type}</span> · answered{' '}
                <span className="text-foreground">{answerWord(question)}</span>
                {question.confidence !== null ? ` · confidence ${question.confidence.toFixed(2)}` : ''}
              </p>
              {state !== undefined ? (
                <SentDialog question={question} state={state} asked={decision.questions.filter((q) => q.request === question.request).length} />
              ) : null}
            </li>
          )
        })}
      </ul>
    </details>
  )
}

function answerWord(question: DecisionQuestionRecord): string {
  return typeof question.answer === 'number' ? question.answer.toFixed(2) : question.answer
}

function SentDialog({
  question,
  state,
  asked,
}: {
  question: DecisionQuestionRecord
  /** The request's whole state text, exactly as sent. */
  state: string
  /** How many questions the request asked about that state, this one included. */
  asked: number
}) {
  const options = Object.entries(question.candidates)
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="xs" className="mt-1.5">
          Show what was sent
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[min(85vh,48rem)] flex-col gap-3 sm:max-w-2xl" data-testid="sent-dialog">
        <DialogHeader className="pr-8">
          <DialogTitle>What the decision model was given</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">The question and the state text it was asked about, exactly as sent.</DialogDescription>
        </DialogHeader>
        <div className="-mx-5 flex min-h-0 flex-col gap-3 overflow-y-auto px-5 text-xs">
          <section aria-label="Question">
            <h3 className="text-2xs font-medium text-muted-foreground">Question</h3>
            <Verbatim className="mt-1">{question.instructions}</Verbatim>
            <p className="mt-1 text-muted-foreground">
              <span className="font-mono text-2xs">{question.id}</span> · <span className="font-mono text-2xs">{question.type}</span> · answered{' '}
              <span className="text-foreground">{answerWord(question)}</span>
            </p>
            {options.length > 0 ? (
              <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5" aria-label={question.type === 'choice' ? 'Options sent' : 'Criteria sent'}>
                {options.map(([option, text]) => (
                  <div key={option} className="contents">
                    <dt className="font-mono text-2xs text-muted-foreground">{option}</dt>
                    <dd>{text}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </section>
          <section aria-label="State sent">
            <h3 className="text-2xs font-medium text-muted-foreground">State sent</h3>
            <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
              {asked === 1 ? 'The only question of its request was asked about this text.' : `All ${asked} questions of its request were asked about this text.`}
            </p>
            <Verbatim className="mt-1 font-mono text-2xs" label="State text sent">
              {state}
            </Verbatim>
          </section>
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}
