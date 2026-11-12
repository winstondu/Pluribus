import type { DecisionQuestionRecord, RunInspection, ShownAnswerForm, ShownSectionView } from '@committee/protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Pill, Verbatim } from '../parts'

/** The form a section's answer was shown in, as the inspector names it. */
const SHOWN_FORM_WORD: { readonly [F in ShownAnswerForm]: string } = {
  full: 'Whole answer',
  passages: 'Opening and matching passages',
  opening: 'Opening only',
  summary: 'Summary',
}

const SHOWN_FORM_NOTE: { readonly [F in ShownAnswerForm]: string } = {
  full: 'The whole answer, as it stood when the message was routed.',
  passages: 'The whole answer did not fit the decision budget: its opening and the passages that share the most words with the message.',
  opening: 'Only the first 280 characters of the answer, as every section the request listed is shown.',
  summary: 'A stored summary of the work before the section and its own content, in place of the answer. The summary’s text is not kept in the log.',
}

/**
 * Item 5's questions: each card shows the question as asked. Where the
 * decision recorded what the question showed of its sections, a button opens
 * it in a dialog, so a long answer does not crowd the side panel.
 */
export function DecisionQuestions({ routing }: { routing: NonNullable<RunInspection['routing']> }) {
  const { decision, shown } = routing
  if (decision.questions.length === 0) return null
  return (
    <details className="mt-1.5 text-xs">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        Questions put to the decision model ({decision.questions.length})
      </summary>
      {decision.source === 'decision-model' && !decision.shownRecorded ? (
        <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground" data-testid="shown-not-recorded">
          Recorded before Committee kept what each question showed of its sections: only the questions are shown.
        </p>
      ) : null}
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {decision.questions.map((question, i) => (
          <li key={`${question.id}-${i}`} className="rounded-md border border-border bg-background px-2.5 py-2 leading-relaxed" data-question={question.id}>
            <p>{question.instructions}</p>
            <p className="mt-1 text-muted-foreground">
              <span className="font-mono text-2xs">{question.type}</span> · answered{' '}
              <span className="text-foreground">{answerWord(question)}</span>
              {question.confidence !== null ? ` · confidence ${question.confidence.toFixed(2)}` : ''}
            </p>
            {shown[i] ? <ShownDialog question={question} sections={shown[i]} /> : null}
          </li>
        ))}
      </ul>
    </details>
  )
}

function answerWord(question: DecisionQuestionRecord): string {
  return typeof question.answer === 'number' ? question.answer.toFixed(2) : question.answer
}

function ShownDialog({ question, sections }: { question: DecisionQuestionRecord; sections: readonly ShownSectionView[] }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="xs" className="mt-1.5">
          Show what was sent
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[min(85vh,48rem)] flex-col gap-3 sm:max-w-2xl" data-testid="shown-dialog">
        <DialogHeader className="pr-8">
          <DialogTitle>What the decision model was given</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            The question, and the line the request’s state showed for {sections.length === 1 ? 'the section it is about' : 'the sections it is about'},
            exactly as sent. The same state also listed the other sections and the new message.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-5 flex min-h-0 flex-col gap-3 overflow-y-auto px-5 text-xs">
          <section aria-label="Question">
            <h3 className="text-2xs font-medium text-muted-foreground">Question</h3>
            <Verbatim className="mt-1">{question.instructions}</Verbatim>
            <p className="mt-1 text-muted-foreground">
              <span className="font-mono text-2xs">{question.id}</span> · <span className="font-mono text-2xs">{question.type}</span> · answered{' '}
              <span className="text-foreground">{answerWord(question)}</span>
            </p>
          </section>
          {sections.map((section) => (
            <section key={section.sectionId} aria-label={`Shown for the section: ${SHOWN_FORM_WORD[section.form]}`} data-form={section.form}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-2xs font-medium text-muted-foreground">Shown for the section</h3>
                <Pill>{SHOWN_FORM_WORD[section.form]}</Pill>
              </div>
              <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">{SHOWN_FORM_NOTE[section.form]}</p>
              <Verbatim className="mt-1 max-h-[45vh] overflow-y-auto font-mono text-2xs" label={`Text shown: ${SHOWN_FORM_WORD[section.form]}`}>
                {section.text}
              </Verbatim>
            </section>
          ))}
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}
