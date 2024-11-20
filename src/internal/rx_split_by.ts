import * as O from 'fp-ts/lib/Option'
import { pipe } from 'fp-ts/lib/function'
import * as Rx from 'rxjs'

/**
 * @desc Disjoin ADT to form union of Observables of ADT members, each with single property.
 *
 * @example
 * interface Two {
 *   readonly kind: 'two'
 *   readonly value: string
 * }
 *
 * interface Three {
 *   readonly kind: 'three'
 *   readonly left: number
 *   readonly right: number
 * }
 *
 * type Union = Two | Three
 * declare const state: Observable<Union>
 * pipe(
 *   state,
 *   splitBy('kind')
 * )
 * // $ShouldBeEqualTo
 * Observable<GroupedObservable<'two', Two> | GroupedObservable<'three', Three>>
 **/
export function splitBy<Tag extends keyof ADT, ADT extends { readonly [K in Tag]: any }>(
  discriminant: Tag
): (state: Rx.Observable<ADT>) => Rx.Observable<Rx.GroupedObservable<ADT[Tag], ADT>> {
  return (state: Rx.Observable<ADT>) =>
    state.pipe(source => source.lift(new SplitByOperator((adt: ADT) => adt[discriminant])))
}

class SplitByOperator<T, K> implements Operator<T, Rx.GroupedObservable<K, T>> {
  constructor(private readonly _keySelector: (value: T) => K) {}

  call(
    subscriber: Rx.Subscriber<Rx.GroupedObservable<K, T>>,
    source: Rx.Subscribable<T>
  ): Rx.TeardownLogic {
    return source.subscribe(new SplitBySubscriber(subscriber, this._keySelector))
  }
}

class SplitBySubscriber<T, K> extends Rx.Subscriber<T> {
  public attemptedToUnsubscribe = false
  public count = 0

  private _currentGroup: O.Option<{ key: K; group: Rx.Subject<T> }> = O.none

  constructor(
    public destination: Rx.Subscriber<Rx.GroupedObservable<K, T>>,
    private readonly _keySelector: (value: T) => K
  ) {
    super(destination)
  }

  protected _next(value: T) {
    const key = this._keySelector(value)

    pipe(
      this._currentGroup,
      O.fold(
        () => this._createGroup(key, value),
        ({ key: currentKey, group }) => {
          if (currentKey !== key) {
            group.complete()
            this._currentGroup = O.none

            this._createGroup(key, value)
          } else if (!group.closed) {
            group.next(value)
          }
        }
      )
    )
  }

  private _createGroup(key: K, value: T) {
    const group = new Rx.BehaviorSubject<T>(value)
    this._currentGroup = O.some({ key, group })

    this.destination.next(this._createGroupedObservable(key, group))
  }

  private _createGroupedObservable(key: K, groupSubject: Rx.SubjectLike<any>) {
    const result: any = new Rx.Observable<T>(groupSubscriber => {
      this.count++
      const innerSub = groupSubject.subscribe(groupSubscriber)
      return () => {
        innerSub.unsubscribe()
        if (--this.count === 0 && this.attemptedToUnsubscribe) {
          this.unsubscribe()
        }
      }
    })

    result.key = key
    return result
  }

  protected _error(err: any) {
    pipe(
      this._currentGroup,
      O.map(({ group }) => group.error(err))
    )
    this._currentGroup = O.none

    this.destination.error(err)
  }

  protected _complete() {
    pipe(
      this._currentGroup,
      O.map(({ group }) => group.complete())
    )
    this._currentGroup = O.none

    this.destination.complete()
  }

  unsubscribe() {
    if (!this.closed) {
      this.attemptedToUnsubscribe = true
      if (this.count === 0) {
        super.unsubscribe()
      }
    }
  }
}

interface Operator<_T, R> {
  call(subscriber: Rx.Subscriber<R>, source: any): Rx.TeardownLogic
}
