import XCTest

@testable import T3Code

/// Cmd+Shift+H in a new task: the next machine, as upstream's mobile client
/// steps it.
final class NewTaskMachineCycleTests: XCTestCase {
    func testStepsToTheNextMachineAndWrapsAround() {
        let machines = ["laptop", "desktop", "server"]
        XCTAssertEqual(NewTaskMachineCycle.next(after: "laptop", in: machines), "desktop")
        XCTAssertEqual(NewTaskMachineCycle.next(after: "server", in: machines), "laptop")
    }

    func testStartsAtTheFirstMachineWhenTheCurrentOneIsNotListed() {
        XCTAssertEqual(NewTaskMachineCycle.next(after: nil, in: ["laptop", "desktop"]), "laptop")
        XCTAssertEqual(NewTaskMachineCycle.next(after: "gone", in: ["laptop", "desktop"]), "laptop")
    }

    func testDoesNothingWithOnlyOneMachine() {
        XCTAssertNil(NewTaskMachineCycle.next(after: "laptop", in: ["laptop"]))
        XCTAssertNil(NewTaskMachineCycle.next(after: nil, in: []))
    }
}
