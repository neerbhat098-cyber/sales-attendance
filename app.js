/* =====================================================
   SUPABASE CONFIGURATION
===================================================== */

const SUPABASE_URL =
    "https://ipcukyillmcyveovtsvc.supabase.co";

const SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_6DgtPKIBh-yqJV0nrIZWXA_AVVR0s7t";

const supabaseClient =
    window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY
    );
    console.log(
    "Supabase client initialized:",
    supabaseClient
);












/* =====================================================
   SALES ATTENDANCE SYSTEM
   FRONTEND PROTOTYPE

   NOTE:
   This version uses localStorage.

   Later we will replace localStorage with:
   PostgreSQL + Node.js backend + Google Drive API.
===================================================== */


/* =====================================================
   DEFAULT DATA
===================================================== */

const DEFAULT_USERS = [
    {
        id: "ADM001",
        name: "System Admin",
        email: "admin@example.com",
        password: "admin123",
        role: "ADMIN"
    },

    {
        id: "EMP001",
        name: "John Smith",
        email: "john@example.com",
        password: "123456",
        role: "EMPLOYEE"
    }
];


const DEFAULT_EMPLOYEES = [
    {
        id: "EMP001",
        name: "John Smith",
        email: "john@example.com",
        department: "Sales",
        status: "Active"
    }
];


/* =====================================================
   STORAGE
===================================================== */





let users = [];

let employees = [];

let attendance = [];

let leaves = [];

let settings = {
    autoCloseTime: "23:59",
    locationInterval: 5,
    requireLocation: true,
    allowBackdatedLeave: true
};

let currentUser = null;

let locationWatcher = null;

let lastLocation = null;

/* =====================================================
   ATTENDANCE LOCATION TRACKING
===================================================== */

let locationIntervalTimer = null;
let locationRequestInProgress = false;
let activeTrackingAttendanceId = null;

const LOCATION_SOURCE = "Browser Geolocation";

function getLocationIntervalMs() {
    // The configured setting is in minutes.
    const minutes = Number(settings.locationInterval) || 60;
    return Math.max(1, minutes) * 60 * 1000;
}

function getPositionOnce(options = {}) {
    return new Promise((resolve, reject) => {
        if (!window.isSecureContext) {
            reject(new Error(
                "Location requires HTTPS or localhost."
            ));
            return;
        }

        if (!navigator.geolocation) {
            reject(new Error(
                "This browser does not support location."
            ));
            return;
        }

        navigator.geolocation.getCurrentPosition(
            resolve,
            error => {
                const messages = {
                    1: "Location permission denied. Allow location for this website in your browser settings.",
                    2: "Your device cannot determine its location. Turn on Location Services and try again.",
                    3: "Location request timed out. Try again with GPS enabled."
                };

                reject(new Error(
                    messages[error.code] ||
                    "Unable to obtain device location."
                ));
            },
            {
                enableHighAccuracy: true,
                timeout: 25000,
                maximumAge: 0,
                ...options
            }
        );
    });
}

function positionToLocation(position) {
    return {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy ?? null,
        timestamp: new Date(
            position.timestamp || Date.now()
        ).toISOString(),
        source: LOCATION_SOURCE
    };
}

async function saveAttendanceLocation(
    attendanceId,
    employeeId,
    location
) {
    const { data, error } = await supabaseClient
        .from("attendance_locations")
        .insert({
            attendance_id: attendanceId,
            employee_id: employeeId,
            latitude: location.latitude,
            longitude: location.longitude,
            accuracy: location.accuracy,
            recorded_at: location.timestamp,
            source: location.source || LOCATION_SOURCE
        })
        .select()
        .single();

    if (error) {
        console.error(
            "Location insert failed:",
            error
        );
        throw error;
    }

    return data;
}

async function recordCurrentLocation(
    record,
    options = {}
) {
    if (!record || record.status !== "ACTIVE") {
        return false;
    }

    if (locationRequestInProgress) {
        return false;
    }

    locationRequestInProgress = true;

    try {
        const position = await getPositionOnce();
        const location = positionToLocation(position);

        // Persist the point first. Do not claim it was saved
        // unless Supabase confirms the insert.
        await saveAttendanceLocation(
            record.id,
            record.employeeId,
            location
        );

        lastLocation = location;

        record.locations = record.locations || [];
        record.locations.push({
            ...location,
            recordedAt: location.timestamp
        });

        record.lastLatitude = location.latitude;
        record.lastLongitude = location.longitude;
        record.lastAccuracy = location.accuracy;

        const statusElement =
            document.getElementById("locationStatus");

        if (statusElement) {
            statusElement.textContent =
                `${location.latitude.toFixed(6)}, ` +
                `${location.longitude.toFixed(6)} ` +
                `(±${Math.round(location.accuracy || 0)}m)`;
        }

        if (!options.silent) {
            showToast("Location saved successfully.");
        }

        return true;
    } catch (error) {
        console.error("Could not record location:", error);

        const statusElement =
            document.getElementById("locationStatus");

        if (statusElement) {
            statusElement.textContent =
                error.message ||
                "Unable to save location.";
        }

        if (!options.silent) {
            showToast(
                "Location was not saved. Check permission and connection."
            );
        }

        return false;
    } finally {
        locationRequestInProgress = false;
    }
}

function stopLocationTracking() {
    if (locationIntervalTimer !== null) {
        clearInterval(locationIntervalTimer);
        locationIntervalTimer = null;
    }

    activeTrackingAttendanceId = null;
}

function startLocationTracking(record) {
    if (!record || record.status !== "ACTIVE") {
        stopLocationTracking();
        return;
    }

    if (
        activeTrackingAttendanceId === record.id &&
        locationIntervalTimer !== null
    ) {
        return;
    }

    stopLocationTracking();
    activeTrackingAttendanceId = record.id;

    locationIntervalTimer = setInterval(async () => {
        const activeRecord = getTodayAttendance();

        if (
            !activeRecord ||
            activeRecord.id !== record.id ||
            activeRecord.status !== "ACTIVE"
        ) {
            stopLocationTracking();
            return;
        }

        await recordCurrentLocation(
            activeRecord,
            { silent: true }
        );
    }, getLocationIntervalMs());
}

// If the browser suspended the page, check again when it
// becomes visible. This does not guarantee background GPS.
document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !currentUser) {
        return;
    }

    const record = getTodayAttendance();

    if (record && record.status === "ACTIVE") {
        startLocationTracking(record);

        // Only record a resumed point if a full interval
        // has elapsed since the last successful point.
        const lastRecordedAt =
            record.locations?.length
                ? new Date(
                    record.locations[
                        record.locations.length - 1
                    ].recordedAt
                ).getTime()
                : new Date(record.startTime).getTime();

        if (
            Date.now() - lastRecordedAt >=
            getLocationIntervalMs()
        ) {
            await recordCurrentLocation(
                record,
                { silent: true }
            );
        }
    }
});


/* =====================================================
   SUPABASE DATABASE
===================================================== */

async function loadUsersFromDatabase() {

    const { data, error } = await supabaseClient

        .from("users")
        .select("*")
        .order("id");

    if (error) {

        console.error(
            "Error loading users:",
            error
        );

        showToast(
            "Failed to load users from database."
        );

        return;
    }

    users = data || [];

    console.log(
        "Users loaded from Supabase:",
        users
    );
}


async function loadEmployeesFromDatabase() {

    const { data, error } = await supabaseClient
        .from("employees")
        .select("*")
        .order("id");

    if (error) {

        console.error(
            "Error loading employees:",
            error
        );

        showToast(
            "Failed to load employees from database."
        );

        return;
    }

    employees = data || [];

    console.log(
        "Employees loaded from Supabase:",
        employees
    );
}


async function loadAttendanceFromDatabase() {

    const { data, error } = await supabaseClient
        .from("attendance")
        .select("*")
        .order("work_date", {
            ascending: false
        });

    if (error) {

        console.error(
            "Error loading attendance:",
            error
        );

        showToast(
            "Failed to load attendance."
        );

        return;
    }

    attendance = (data || []).map(record => ({

    id:
        record.id,

    employeeId:
        record.employee_id,

    employeeName:
        record.employee_name,

    workDate:
        record.work_date,

    startTime:
        record.start_time,

    endTime:
        record.end_time,

    startLatitude:
        record.start_latitude,

    startLongitude:
        record.start_longitude,

    startAccuracy:
        record.start_accuracy,

    startAddress:
        record.start_address,

    endLatitude:
        record.end_latitude,

    endLongitude:
        record.end_longitude,

    endAccuracy:
        record.end_accuracy,

    endAddress:
        record.end_address,

    lastLatitude:
        record.last_latitude,

    lastLongitude:
        record.last_longitude,

    lastAccuracy:
        record.last_accuracy,

    status:
        record.status,

    endType:
        record.end_type,

    totalWorkMinutes:
        record.total_work_minutes || 0,

    leaveType:
        record.leave_type,

    locations:
        []

}));

    console.log(
        "Attendance loaded from Supabase:",
        attendance
    );
}


async function loadLeavesFromDatabase() {

    const { data, error } = await supabaseClient
        .from("leaves")
        .select("*")
        .order("applied_date", {
            ascending: false
        });

    if (error) {

        console.error(
            "Error loading leaves:",
            error
        );

        showToast(
            "Failed to load leaves."
        );

        return;
    }

        leaves = (data || []).map(record => ({

        id:
            record.id,

        employeeId:
            record.employee_id,

        employeeName:
            record.employee_name,

        leaveType:
            record.leave_type,

        startDate:
            record.start_date,

        endDate:
            record.end_date,

        reason:
            record.reason,

        appliedDate:
            record.applied_date,

        status:
            record.status,

        adminComment:
            record.admin_comment,

        approvedBy:
            record.approved_by,

        approvedAt:
            record.approved_at,

        isBackdated:
            record.is_backdated

    }));


    console.log(
        "Leaves loaded from Supabase:",
        leaves
    );
}


async function loadSettingsFromDatabase() {

    const { data, error } = await supabaseClient
        .from("system_settings")
        .select("*")
        .limit(1)
        .maybeSingle();

    if (error) {

        console.error(
            "Error loading settings:",
            error
        );

        return;
    }

    if (data) {

        settings = {

            autoCloseTime:
                data.auto_close_time || "23:59",

            locationInterval:
                Number(
                    data.location_interval || 5
                ),

            requireLocation:
                data.require_location !== false,

            allowBackdatedLeave:
                data.allow_backdated_leave !== false

        };

    }

    console.log(
        "Settings loaded from Supabase:",
        settings
    );
}


async function loadDatabaseData() {
    console.log("Loading application data from Supabase...");

    await loadUsersFromDatabase();
    await loadEmployeesFromDatabase();
    await loadAttendanceFromDatabase();

    try {
        await loadAttendanceLocationsFromDatabase();
    } catch (error) {
        console.error("Location history is unavailable:", error);
    }

    await loadLeavesFromDatabase();
    await loadSettingsFromDatabase();

    console.log("Application data loaded.");
}



/* =====================================================
   DOM
===================================================== */

const loginScreen =
    document.getElementById("loginScreen");

const appScreen =
    document.getElementById("appScreen");

const loginForm =
    document.getElementById("loginForm");

const loginEmail =
    document.getElementById("loginEmail");

const loginPassword =
    document.getElementById("loginPassword");

const logoutBtn =
    document.getElementById("logoutBtn");


/* =====================================================
   UTILITIES
===================================================== */

function todayString() {

    const date = new Date();

    const year =
        date.getFullYear();

    const month =
        String(date.getMonth() + 1)
            .padStart(2, "0");

    const day =
        String(date.getDate())
            .padStart(2, "0");

    return `${year}-${month}-${day}`;
}


function formatDate(dateString) {

    if (!dateString) {
        return "-";
    }

    const date =
        new Date(dateString + "T00:00:00");

    return date.toLocaleDateString(
        undefined,
        {
            day: "2-digit",
            month: "short",
            year: "numeric"
        }
    );
}


function formatTime(dateString) {

    if (!dateString) {
        return "-";
    }

    return new Date(dateString)
        .toLocaleTimeString(
            undefined,
            {
                hour: "2-digit",
                minute: "2-digit"
            }
        );
}


function showToast(message) {

    const toast =
        document.getElementById("toast");

    toast.textContent = message;

    toast.classList.add("show");

    setTimeout(() => {

        toast.classList.remove("show");

    }, 3000);
}


function escapeHtml(value) {

    if (value === null || value === undefined) {
        return "";
    }

    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


/* =====================================================
   LOGIN
===================================================== */

loginForm.addEventListener(
    "submit",
    function (event) {

        event.preventDefault();

        const email =
            loginEmail.value.trim();

        const password =
            loginPassword.value;

        const user =
            users.find(
                item =>
                    item.email === email &&
                    item.password === password
            );

        if (!user) {

            showToast(
                "Invalid email or password."
            );

            return;
        }

        currentUser = user;

        localStorage.setItem(
            "sales_current_user",
            JSON.stringify(user)
        );

        openApplication();

    }
);


/* =====================================================
   AUTO LOGIN
===================================================== */

function checkExistingLogin() {

    const saved =
        localStorage.getItem(
            "sales_current_user"
        );

    if (!saved) {

        loginScreen.classList.remove("hidden");
        appScreen.classList.add("hidden");

        return;

    }

    try {

        currentUser =
            JSON.parse(saved);

        /*
         * Get the latest user information
         * from the database.
         */
        const latestUser =
            users.find(
                user =>
                    user.id === currentUser.id
            );

        if (!latestUser) {

            /*
             * User no longer exists
             * in the database.
             */
            localStorage.removeItem(
                "sales_current_user"
            );

            currentUser = null;

            loginScreen.classList.remove("hidden");
            appScreen.classList.add("hidden");

            return;
        }

        currentUser = latestUser;

        /*
         * Save the latest user information.
         */
        localStorage.setItem(
            "sales_current_user",
            JSON.stringify(currentUser)
        );

        /*
         * Open application.
         */
        openApplication();

    } catch (error) {

        console.error(
            "Auto login error:",
            error
        );

        localStorage.removeItem(
            "sales_current_user"
        );

        currentUser = null;

        loginScreen.classList.remove("hidden");
        appScreen.classList.add("hidden");
    }
}
/* =====================================================
   RESTORE LAST OPENED PAGE
===================================================== */

function restoreLastPage() {

    const savedPage =
        localStorage.getItem(
            "sales_current_page"
        );

    const allowedPages = [
        "dashboard",
        "attendance",
        "leave",
        "employees",
        "adminLeaves",
        "reports",
        "settings"
    ];

    /*
     * No saved page
     */
    if (
        !savedPage ||
        !allowedPages.includes(savedPage)
    ) {

        showPage("dashboard");

        return;
    }

    /*
     * Employee cannot access admin pages.
     */
    const adminOnlyPages = [
        "employees",
        "adminLeaves",
        "reports",
        "settings"
    ];

    if (
        currentUser.role !== "ADMIN" &&
        adminOnlyPages.includes(savedPage)
    ) {

        showPage("dashboard");

        return;
    }

    /*
     * Restore exactly the page
     * that was open before refresh.
     */
    showPage(savedPage);
}


/* =====================================================
   OPEN APPLICATION
===================================================== */

function openApplication() {

    loginScreen.classList.add("hidden");

    appScreen.classList.remove("hidden");

    document.getElementById(
        "loggedUserName"
    ).textContent =
        currentUser.name;

    document.getElementById(
        "loggedUserRole"
    ).textContent =
        currentUser.role;

    document.getElementById(
        "welcomeName"
    ).textContent =
        currentUser.name;

    document.getElementById(
        "userAvatar"
    ).textContent =
        currentUser.name
            .charAt(0)
            .toUpperCase();

    document.getElementById(
        "currentDate"
    ).textContent =
        new Date().toLocaleDateString(
            undefined,
            {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric"
            }
        );

    document.getElementById(
        "dashboardDate"
    ).textContent =
        formatDate(todayString());

setupRolePermissions();

renderAll();

runAutoCloseCheck();
restoreLastPage();

/*
 * Restore the last opened menu
 */
const savedPage =
    localStorage.getItem(
        "sales_current_page"
    );


const allowedPages = [
    "dashboard",
    "attendance",
    "leave",
    "employees",
    "adminLeaves",
    "reports",
    "settings"
];


if (
    savedPage &&
    allowedPages.includes(savedPage)
) {

    /*
     * Prevent employee users from
     * opening admin-only pages
     */
    if (
        currentUser.role !== "ADMIN" &&
        [
            "employees",
            "adminLeaves",
            "reports",
            "settings"
        ].includes(savedPage)
    ) {

        showPage("dashboard");

    } else {

        showPage(savedPage);

    }

} else {

    showPage("dashboard");

}
// Load saved profile photo if available
if (currentUser) {
    const savedAvatar = localStorage.getItem(`sales_avatar_${currentUser.id}`);
    applyUserAvatar(savedAvatar);
}

    
}
document
    .getElementById("refreshDataBtn")
    .addEventListener(
        "click",
        async function () {

            const button = this;

            if (!currentUser) {
                return;
            }

            button.classList.add("loading");
            button.disabled = true;

            try {

                await loadDatabaseData();

                renderAll();

                showToast(
                    "Data refreshed successfully."
                );

            } catch (error) {

                console.error(
                    "Refresh error:",
                    error
                );

                showToast(
                    "Failed to refresh data."
                );

            } finally {

                button.classList.remove(
                    "loading"
                );

                button.disabled = false;

            }

        }
    );

/* =====================================================
   LOGOUT
===================================================== */

logoutBtn.addEventListener(
    "click",
    function () {

        if (locationWatcher !== null) {

            navigator.geolocation.clearWatch(
                locationWatcher
            );

            locationWatcher = null;
        }

        currentUser = null;

        localStorage.removeItem(
            "sales_current_user"
        );

        appScreen.classList.add("hidden");

        loginScreen.classList.remove(
            "hidden"
        );

        loginForm.reset();

    }
);


/* =====================================================
   ROLE PERMISSIONS
===================================================== */

function setupRolePermissions() {

    const adminItems =
        document.querySelectorAll(
            ".admin-only"
        );

    adminItems.forEach(
        item => {

            if (
                currentUser.role === "ADMIN"
            ) {

                item.style.display = "";

            } else {

                item.style.display =
                    "none";

            }

        }
    );
}


/* =====================================================
   NAVIGATION
===================================================== */

document
    .querySelectorAll(".nav-item")
    .forEach(button => {

        button.addEventListener(
            "click",
            function () {

                showPage(
                    this.dataset.page
                );

            }
        );

    });


document
    .querySelectorAll("[data-page-link]")
    .forEach(button => {

        button.addEventListener(
            "click",
            function () {

                showPage(
                    this.dataset.pageLink
                );

            }
        );

    });


function showPage(pageName) {

        /*
     * Remember the currently opened menu
     */
    localStorage.setItem(
        "sales_current_page",
        pageName
    );

   
    document
        .querySelectorAll(".page")
        .forEach(page => {

            page.classList.add("hidden");

        });


    const page =
        document.getElementById(
            pageName + "Page"
        );


    if (page) {

        page.classList.remove("hidden");

    }


    document
        .querySelectorAll(".nav-item")
        .forEach(button => {

            button.classList.remove("active");


            if (
                button.dataset.page ===
                pageName
            ) {

                button.classList.add("active");

            }

        });


    const titles = {

        dashboard:
            "Dashboard",

        attendance:
            "Attendance",

        leave:
            "Leave Management",

        employees:
            "Employees",

        adminLeaves:
            "Leave Approval",

        reports:
            "Reports",

        settings:
            "Settings"

    };


    document.getElementById(
        "pageTitle"
    ).textContent =
        titles[pageName] ||
        "Dashboard";


    /*
     * Remember the current menu
     */
    localStorage.setItem(
        "sales_current_page",
        pageName
    );


    renderAll();

}


/* =====================================================
   CURRENT ATTENDANCE
===================================================== */

function getTodayAttendance() {

    if (!currentUser) {
        return null;
    }

    return attendance.find(
        item =>
            (item.employeeId || item.employee_id) === currentUser.id &&
            (item.workDate || item.work_date) === todayString()
    );
}



/* =====================================================
   START DAY
===================================================== */

document
    .getElementById("startDayBtn")
    .addEventListener(
        "click",
        startDay
    );


async function startDay() {
    if (!currentUser) {
        showToast("Please log in first.");
        return;
    }

    const existing = getTodayAttendance();

    if (existing) {
        showToast("Attendance has already started.");
        return;
    }

    const startButton =
        document.getElementById("startDayBtn");

    startButton.disabled = true;

    const statusElement =
        document.getElementById("locationStatus");

    statusElement.textContent =
        "Checking location permission...";

    try {
        // Obtain location before creating attendance so a
        // required-location failure does not create an empty day.
        let position = null;

        if (settings.requireLocation) {
            position = await getPositionOnce();
        } else {
            try {
                position = await getPositionOnce();
            } catch (error) {
                console.warn(
                    "Starting without location:",
                    error.message
                );
            }
        }

        const now = new Date();
        const attendanceId = crypto.randomUUID();

        const record = {
            id: attendanceId,
            employeeId: currentUser.id,
            employeeName: currentUser.name,
            workDate: todayString(),
            startTime: now.toISOString(),
            startLatitude: position?.coords.latitude ?? null,
            startLongitude: position?.coords.longitude ?? null,
            startAccuracy: position?.coords.accuracy ?? null,
            startAddress: position
                ? "Coordinates recorded"
                : null,
            endTime: null,
            endLatitude: null,
            endLongitude: null,
            endAccuracy: null,
            endAddress: null,
            lastLatitude: position?.coords.latitude ?? null,
            lastLongitude: position?.coords.longitude ?? null,
            lastAccuracy: position?.coords.accuracy ?? null,
            status: "ACTIVE",
            endType: null,
            totalWorkMinutes: 0,
            locations: []
        };

        const attendanceRecord = {
            id: record.id,
            employee_id: record.employeeId,
            employee_name: record.employeeName,
            work_date: record.workDate,
            start_time: record.startTime,
            start_latitude: record.startLatitude,
            start_longitude: record.startLongitude,
            start_accuracy: record.startAccuracy,
            start_address: record.startAddress,
            end_time: null,
            end_latitude: null,
            end_longitude: null,
            end_accuracy: null,
            end_address: null,
            status: "ACTIVE",
            end_type: null,
            total_work_minutes: 0
        };

        const { data, error } = await supabaseClient
            .from("attendance")
            .insert(attendanceRecord)
            .select()
            .single();

        if (error) {
            throw new Error(
                "Could not start attendance: " + error.message
            );
        }

        // Use the actual ID returned by the database.
        record.id = data.id;

        if (position) {
            const location = positionToLocation(position);

            try {
                await saveAttendanceLocation(
                    record.id,
                    record.employeeId,
                    location
                );

                record.locations.push({
                    ...location,
                    recordedAt: location.timestamp
                });

                lastLocation = location;
            } catch (locationError) {
                // Do not leave an untracked active attendance
                // when location is mandatory.
                if (settings.requireLocation) {
                    await supabaseClient
                        .from("attendance")
                        .delete()
                        .eq("id", record.id)
                        .eq("status", "ACTIVE");

                    throw new Error(
                        "The start location could not be saved. " +
                        "Attendance was not started. " +
                        locationError.message
                    );
                }

                console.error(locationError);
                showToast(
                    "Attendance started, but its location could not be saved."
                );
            }
        }

        attendance.push(record);

        if (position) {
            statusElement.textContent =
                `${position.coords.latitude.toFixed(6)}, ` +
                `${position.coords.longitude.toFixed(6)} ` +
                `(±${Math.round(position.coords.accuracy)}m)`;
        } else {
            statusElement.textContent =
                "Attendance active; location unavailable.";
        }

        startLocationTracking(record);
        renderAll();

        showToast("Attendance started successfully.");
    } catch (error) {
        console.error("Start day failed:", error);

        statusElement.textContent = error.message;

        showToast(error.message);
    } finally {
        startButton.disabled = false;
        renderDashboard();
    }
}

/* =====================================================
   LOAD ATTENDANCE LOCATIONS FROM SUPABASE
===================================================== */

async function loadAttendanceLocationsFromDatabase() {
    const { data, error } = await supabaseClient
        .from("attendance_locations")
        .select("*")
        .order("recorded_at", { ascending: true });

    if (error) {
        console.error("Error loading attendance locations:", error);
        throw error;
    }

    // Map the loaded location points back into their respective attendance records
    if (data && data.length > 0) {
        data.forEach(loc => {
            const match = attendance.find(att => att.id === loc.attendance_id);
            if (match) {
                match.locations = match.locations || [];
                match.locations.push({
                    latitude: loc.latitude,
                    longitude: loc.longitude,
                    accuracy: loc.accuracy,
                    recordedAt: loc.recorded_at,
                    source: loc.source
                });
            }
        });
    }

    console.log("Attendance locations loaded from Supabase:", data);
}
/* =====================================================
   END DAY
===================================================== */

document
    .getElementById("endDayBtn")
    .addEventListener(
        "click",
        endDay
    );


async function endDay() {
    const record = getTodayAttendance();

    if (!record) {
        showToast("Today's attendance has not started.");
        return;
    }

    if (record.status !== "ACTIVE") {
        showToast("Attendance is already closed.");
        return;
    }

    const endButton = document.getElementById("endDayBtn");
    endButton.disabled = true;

    try {
        let position = null;

        try {
            position = await getPositionOnce();
        } catch (locationError) {
            console.warn(
                "Final location unavailable:",
                locationError.message
            );
        }

        const now = new Date();
        const endTime = now.toISOString();

        let endLatitude = null;
        let endLongitude = null;
        let endAccuracy = null;

        if (position) {
            const location = positionToLocation(position);

            // Save the end point before closing attendance.
            await saveAttendanceLocation(
                record.id,
                record.employeeId,
                location
            );

            record.locations = record.locations || [];
            record.locations.push({
                ...location,
                recordedAt: location.timestamp
            });

            endLatitude = location.latitude;
            endLongitude = location.longitude;
            endAccuracy = location.accuracy;
        }

        const update = {
            end_time: endTime,
            end_latitude: endLatitude,
            end_longitude: endLongitude,
            end_accuracy: endAccuracy,
            end_address: position
                ? "Coordinates recorded"
                : null,
            status: "COMPLETED",
            end_type: "MANUAL",
            total_work_minutes: calculateMinutes(
                record.startTime,
                endTime
            )
        };

        const { data, error } = await supabaseClient
            .from("attendance")
            .update(update)
            .eq("id", record.id)
            .eq("status", "ACTIVE")
            .select()
            .maybeSingle();

        if (error) {
            throw new Error(
                "Could not save attendance end: " + error.message
            );
        }

        if (!data) {
            throw new Error(
                "Attendance was already closed or could not be updated."
            );
        }

        Object.assign(record, {
            endTime: data.end_time,
            endLatitude: data.end_latitude,
            endLongitude: data.end_longitude,
            endAccuracy: data.end_accuracy,
            endAddress: data.end_address,
            status: data.status,
            endType: data.end_type,
            totalWorkMinutes: data.total_work_minutes
        });

        stopLocationTracking();

        showToast(
            position
                ? "Attendance ended and final location saved."
                : "Attendance ended; final GPS location was unavailable."
        );

        renderAll();
    } catch (error) {
        console.error("End day failed:", error);
        showToast(error.message);
    } finally {
        endButton.disabled = false;
        renderDashboard();
    }
}

/* =====================================================
   CALCULATE WORKING MINUTES
===================================================== */

function calculateMinutes(
    start,
    end
) {

    const startDate =
        new Date(start);

    const endDate =
        new Date(end);

    const difference =
        endDate.getTime() -
        startDate.getTime();

    return Math.max(
        0,
        Math.floor(
            difference / 60000
        )
    );

}


function formatMinutes(minutes) {

    const hours =
        Math.floor(
            minutes / 60
        );

    const mins =
        minutes % 60;

    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;

}


/* =====================================================
   MIDNIGHT AUTO CLOSE
===================================================== */

function runAutoCloseCheck() {

    const now =
        new Date();

    const currentTime =
        `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;


    attendance.forEach(
        record => {

            if (
                record.status !==
                "ACTIVE"
            ) {
                return;
            }


            if (
                record.workDate <
                todayString()
            ) {

                autoCloseAttendance(
                    record
                );

                return;
            }


            if (
                record.workDate ===
                todayString() &&
                currentTime >=
                settings.autoCloseTime
            ) {

                autoCloseAttendance(
                    record
                );

            }

        }
    );



}



async function autoCloseAttendance(record) {

    if (
        !record ||
        record.status !== "ACTIVE" ||
        record._autoClosing
    ) {
        return;
    }

    // Prevent repeated database updates while one is in progress.
    record._autoClosing = true;

    try {

        const end = new Date(
            record.workDate + "T23:59:59"
        );

        const endTime = end.toISOString();

        const totalWorkMinutes = calculateMinutes(
            record.startTime,
            endTime
        );

        // Save the automatic closure in Supabase first.
        const { data, error } = await supabaseClient
            .from("attendance")
            .update({
                end_time: endTime,
                status: "AUTO_CLOSED",
                end_type: "AUTO_MIDNIGHT",
                total_work_minutes: totalWorkMinutes,
                updated_at: new Date().toISOString()
            })
            .eq("id", record.id)
            .eq("status", "ACTIVE")
            .select()
            .maybeSingle();

        if (error) {
            console.error(
                "Auto-close attendance failed:",
                error
            );
            return;
        }

        // Update browser memory only after the database succeeds.
        if (data) {

            record.endTime = data.end_time;
            record.status = data.status;
            record.endType = data.end_type;
            record.totalWorkMinutes =
                data.total_work_minutes;

            console.log(
                "Attendance automatically closed in Supabase:",
                record.id
            );

            renderDashboard();

        } else {

            // The database record may already have been closed.
            await loadAttendanceFromDatabase();

            renderAll();

        }

    } catch (error) {

        console.error(
            "Unexpected auto-close error:",
            error
        );

    } finally {

        record._autoClosing = false;

    }
}


/* =====================================================
   LEAVE APPLICATION
===================================================== */

document
    .getElementById("leaveForm")
    .addEventListener(
        "submit",
       async function (event) {

            event.preventDefault();


            const startDate =
                document.getElementById(
                    "leaveStartDate"
                ).value;

            const endDate =
                document.getElementById(
                    "leaveEndDate"
                ).value;


            if (
                endDate < startDate
            ) {

                showToast(
                    "End date cannot be before start date."
                );

                return;
            }


            const leave = {

                id:
                    crypto.randomUUID(),

                employeeId:
                    currentUser.id,

                employeeName:
                    currentUser.name,

                leaveType:
                    document.getElementById(
                        "leaveType"
                    ).value,

                startDate,

                endDate,

                reason:
                    document.getElementById(
                        "leaveReason"
                    ).value,

                appliedDate:
                    todayString(),

                status:
                    "PENDING",

                adminComment:
                    "",

                approvedBy:
                    null,

                approvedAt:
                    null,

                isBackdated:
                    startDate <
                    todayString()

            };


const { data, error } = await supabaseClient
    .from("leaves")
    .insert([{
        id: leave.id,
        employee_id: leave.employeeId,
        employee_name: leave.employeeName,
        leave_type: leave.leaveType,
        start_date: leave.startDate,
        end_date: leave.endDate,
        reason: leave.reason,
        applied_date: leave.appliedDate,
        status: leave.status,
        admin_comment: leave.adminComment,
        approved_by: leave.approvedBy,
        approved_at: leave.approvedAt,
        is_backdated: leave.isBackdated
    }])
    .select()
    .single();

if (error) {
    console.error("Leave insert error:", error);
    showToast("Failed to submit leave request.");
    return;
}

leaves.push(data);

            document
                .getElementById(
                    "leaveForm"
                )
                .reset();


            showToast(
                "Leave request submitted."
            );


            renderAll();

        }
    );


/* =====================================================
   LEAVE APPROVAL
===================================================== */

async function approveLeave(leaveId) {

    const leave = leaves.find(
        item => item.id === leaveId
    );

    if (!leave) {

        showToast(
            "Leave request not found."
        );

        return;
    }


    const approvedAt =
        new Date().toISOString();


    /*
     * UPDATE LEAVE IN SUPABASE
     */

    const { data, error } =
        await supabaseClient
            .from("leaves")
            .update({

                status: "APPROVED",

                approved_by:
                    currentUser.name,

                approved_at:
                    approvedAt,

                admin_comment:
                    "Approved by admin"

            })
            .eq(
                "id",
                leaveId
            )
            .select()
            .single();


    /*
     * CHECK SUPABASE ERROR
     */

    if (error) {

        console.error(
            "Approve leave error:",
            error
        );

        showToast(
            "Failed to approve leave."
        );

        return;
    }


    console.log(
        "Leave approved in Supabase:",
        data
    );


    /*
     * Update local object
     */

    leave.status =
        data.status;

    leave.approvedBy =
        data.approved_by;

    leave.approvedAt =
        data.approved_at;

    leave.adminComment =
        data.admin_comment;


    /*
     * Create attendance for leave
     */

    await createLeaveAttendance(
        leave
    );


    /*
     * Reload leaves from Supabase
     */

    await loadLeavesFromDatabase();


    showToast(
        "Leave approved successfully."
    );


    renderAll();

}


async function rejectLeave(leaveId) {

    const comment = prompt(
        "Enter rejection reason:"
    );

    // User cancelled the prompt
    if (comment === null) {
        return;
    }


    const leave = leaves.find(
        item => item.id === leaveId
    );

    if (!leave) {

        showToast(
            "Leave request not found."
        );

        return;
    }


    const rejectedAt =
        new Date().toISOString();


    /*
     * UPDATE LEAVE IN SUPABASE
     */

    const { data, error } =
        await supabaseClient
            .from("leaves")
            .update({

                status: "REJECTED",

                admin_comment:
                    comment.trim() ||
                    "Rejected by admin",

                approved_by:
                    currentUser.name,

                approved_at:
                    rejectedAt

            })
            .eq(
                "id",
                leaveId
            )
            .select()
            .single();


    /*
     * IF SUPABASE RETURNS ERROR
     */

    if (error) {

        console.error(
            "Reject leave error:",
            error
        );

        showToast(
            "Failed to reject leave."
        );

        return;
    }


    /*
     * SUPABASE UPDATE SUCCESSFUL
     */

    console.log(
        "Leave rejected in Supabase:",
        data
    );


    /*
     * Update local JavaScript object
     */

    leave.status =
        data.status;

    leave.adminComment =
        data.admin_comment;

    leave.approvedBy =
        data.approved_by;

    leave.approvedAt =
        data.approved_at;


    /*
     * Reload leaves from Supabase
     * so the screen shows database data.
     */

    await loadLeavesFromDatabase();


    showToast(
        "Leave rejected successfully."
    );


    renderAll();

}


/* =====================================================
   CREATE LEAVE ATTENDANCE
===================================================== */

async function createLeaveAttendance(leave) {

    const recordsToInsert = [];

    const start =
        new Date(
            leave.startDate + "T00:00:00"
        );

    const end =
        new Date(
            leave.endDate + "T00:00:00"
        );


    while (start <= end) {

        const date =
            start.toISOString()
                .split("T")[0];


        /*
         * Check if attendance already exists
         */

        const {
            data: existingRecords,
            error: checkError
        } = await supabaseClient
            .from("attendance")
            .select("id")
            .eq(
                "employee_id",
                leave.employeeId
            )
            .eq(
                "work_date",
                date
            )
            .limit(1);


        if (checkError) {

            console.error(
                "Attendance check error:",
                checkError
            );

            start.setDate(
                start.getDate() + 1
            );

            continue;
        }


        /*
         * Only create attendance
         * if no record already exists.
         */

        if (
            !existingRecords ||
            existingRecords.length === 0
        ) {

            recordsToInsert.push({

                id:
                    crypto.randomUUID(),

                employee_id:
                    leave.employeeId,

                employee_name:
                    leave.employeeName,

                work_date:
                    date,

                start_time:
                    null,

                end_time:
                    null,

                start_latitude:
                    null,

                start_longitude:
                    null,

                start_accuracy:
                    null,

                start_address:
                    null,

                end_latitude:
                    null,

                end_longitude:
                    null,

                end_accuracy:
                    null,

                end_address:
                    null,

                status:
                    "LEAVE",

                end_type:
                    null,

                total_work_minutes:
                    0

            });

        }


        start.setDate(
            start.getDate() + 1
        );

    }


    /*
     * Nothing new to insert
     */

    if (
        recordsToInsert.length === 0
    ) {

        console.log(
            "No new leave attendance records needed."
        );

        return;

    }


    /*
     * INSERT INTO SUPABASE
     */

    const {
        data,
        error
    } = await supabaseClient
        .from("attendance")
        .insert(
            recordsToInsert
        )
        .select();


    if (error) {

        console.error(
            "Leave attendance insert error:",
            error
        );

        showToast(
            "Leave approved, but attendance could not be created."
        );

        return;

    }


    console.log(
        "Leave attendance created in Supabase:",
        data
    );


    /*
     * Update local JavaScript array
     * using the actual Supabase records.
     */

    data.forEach(
        record => {

            attendance.push({

                id:
                    record.id,

                employeeId:
                    record.employee_id,

                employeeName:
                    record.employee_name,

                workDate:
                    record.work_date,

                startTime:
                    record.start_time,

                endTime:
                    record.end_time,

                startLatitude:
                    record.start_latitude,

                startLongitude:
                    record.start_longitude,

                startAccuracy:
                    record.start_accuracy,

                startAddress:
                    record.start_address,

                endLatitude:
                    record.end_latitude,

                endLongitude:
                    record.end_longitude,

                endAccuracy:
                    record.end_accuracy,

                endAddress:
                    record.end_address,

                status:
                    record.status,

                endType:
                    record.end_type,

                totalWorkMinutes:
                    record.total_work_minutes || 0,

                leaveType:
                    leave.leaveType,

                locations:
                    []

            });

        }
    );

}


/* =====================================================
   USER ID GENERATION
===================================================== */

function generateUserId(role) {

    const prefix =
        role === "ADMIN"
            ? "ADM"
            : "EMP";


    const list =
        users.filter(
            user =>
                user.id.startsWith(prefix)
        );


    let maxNumber = 0;


    list.forEach(
        user => {

            const number =
                parseInt(
                    user.id.replace(
                        prefix,
                        ""
                    ),
                    10
                );


            if (
                !isNaN(number) &&
                number > maxNumber
            ) {

                maxNumber =
                    number;

            }

        }
    );


    return prefix +
        String(
            maxNumber + 1
        ).padStart(
            3,
            "0"
        );

}




/* =====================================================
   ADD EMPLOYEE / USER
===================================================== */

document
    .getElementById("addEmployeeBtn")
    .addEventListener(
        "click",
        function () {

            document
                .getElementById("employeeModal")
                .classList.remove("hidden");

        }
    );


document
    .getElementById("closeEmployeeModal")
    .addEventListener(
        "click",
        function () {

            document
                .getElementById("employeeModal")
                .classList.add("hidden");

        }
    );


document
    .getElementById("employeeForm")
    .addEventListener(
        "submit",
        async function (event) {

            event.preventDefault();


            const role =
                document.getElementById(
                    "employeeRole"
                ).value;


            const name =
                document.getElementById(
                    "employeeName"
                ).value.trim();


            const email =
                document.getElementById(
                    "employeeEmail"
                ).value.trim().toLowerCase();


            const department =
                document.getElementById(
                    "employeeDepartment"
                ).value.trim();


            const password =
                document.getElementById(
                    "employeePassword"
                ).value;


            /* =================================================
               VALIDATE FORM
            ================================================= */

            if (
                !role ||
                !name ||
                !email ||
                !password
            ) {

                showToast(
                    "Please fill all required fields."
                );

                return;
            }


            /* =================================================
               CHECK DUPLICATE EMAIL
            ================================================= */

            const existingUser =
                users.find(
                    user =>
                        user.email.toLowerCase() ===
                        email
                );


            if (existingUser) {

                showToast(
                    "A user with this email already exists."
                );

                return;
            }


            /* =================================================
               CREATE USER OBJECT
            ================================================= */

            const newUser = {

                id:
                    generateUserId(role),

                name:
                    name,

                email:
                    email,

                password:
                    password,

                role:
                    role

            };


            /* =================================================
               INSERT USER INTO SUPABASE
            ================================================= */

            const {
                data: createdUser,
                error: userError
            } = await supabaseClient
                .from("users")
                .insert([newUser])
                .select()
                .single();


            if (userError) {

                console.error(
                    "User insert error:",
                    userError
                );

                showToast(
                    "Failed to create user: " +
                    userError.message
                );

                return;
            }


            console.log(
                "User created in Supabase:",
                createdUser
            );


            /* =================================================
               CREATE EMPLOYEE PROFILE
               ONLY FOR EMPLOYEE
            ================================================= */

            if (
                role === "EMPLOYEE"
            ) {

                const employeeRecord = {

                    id:
                        newUser.id,

                    name:
                        newUser.name,

                    email:
                        newUser.email,

                    department:
                        department,

                    status:
                        "Active"

                };


                const {
                    data: createdEmployee,
                    error: employeeError
                } = await supabaseClient
                    .from("employees")
                    .insert([employeeRecord])
                    .select()
                    .single();


                /* =================================================
                   IF EMPLOYEE INSERT FAILS
                   REMOVE USER AGAIN
                ================================================= */

                if (employeeError) {

                    console.error(
                        "Employee insert error:",
                        employeeError
                    );


                    await supabaseClient
                        .from("users")
                        .delete()
                        .eq(
                            "id",
                            newUser.id
                        );


                    showToast(
                        "Employee creation failed: " +
                        employeeError.message
                    );

                    return;
                }


                console.log(
                    "Employee created in Supabase:",
                    createdEmployee
                );


                /* 
                 * Add employee to local memory
                 * only after successful database insert.
                 */

                employees.push({
                    id:
                        createdEmployee.id,

                    name:
                        createdEmployee.name,

                    email:
                        createdEmployee.email,

                    department:
                        createdEmployee.department,

                    status:
                        createdEmployee.status
                });

            }


            /* =================================================
               ADD USER TO LOCAL MEMORY
               AFTER SUPABASE SUCCESS
            ================================================= */

            users.push({

                id:
                    createdUser.id,

                name:
                    createdUser.name,

                email:
                    createdUser.email,

                password:
                    createdUser.password,

                role:
                    createdUser.role

            });


            /* =================================================
               RESET FORM
            ================================================= */

            document
                .getElementById("employeeForm")
                .reset();


            document
                .getElementById("employeeModal")
                .classList.add("hidden");


            /* =================================================
               SUCCESS MESSAGE
            ================================================= */

            showToast(
                role === "EMPLOYEE"
                    ? "Employee added successfully."
                    : "Admin added successfully."
            );


            renderAll();

        }
    );

/* =====================================================
   RENDER DASHBOARD
===================================================== */

function renderDashboard() {

    const record =
        getTodayAttendance();


    const status =
        document.getElementById(
            "todayStatus"
        );

    const badge =
        document.getElementById(
            "attendanceBadge"
        );

    const startBtn =
        document.getElementById(
            "startDayBtn"
        );

    const endBtn =
        document.getElementById(
            "endDayBtn"
        );


    if (!record) {

        status.textContent =
            "Not Started";

        badge.textContent =
            "NOT STARTED";

        badge.className =
            "status-badge gray";

        startBtn.disabled =
            false;

        endBtn.disabled =
            true;

        document.getElementById(
            "locationStatus"
        ).textContent =
            "Waiting for attendance";

    } else {

        status.textContent =
            record.status;

        badge.textContent =
            record.status.replace(
                "_",
                " "
            );


        if (
            record.status ===
            "ACTIVE"
        ) {

            badge.className =
                "status-badge green";

            startBtn.disabled =
                true;

            endBtn.disabled =
                false;

        } else if (
            record.status ===
            "COMPLETED"
        ) {

            badge.className =
                "status-badge blue";

            startBtn.disabled =
                true;

            endBtn.disabled =
                true;

        } else if (
            record.status ===
            "AUTO_CLOSED"
        ) {

            badge.className =
                "status-badge orange";

            startBtn.disabled =
                true;

            endBtn.disabled =
                true;

        } else if (
            record.status ===
            "LEAVE"
        ) {

            badge.className =
                "status-badge purple";

            startBtn.disabled =
                true;

            endBtn.disabled =
                true;

        }


        if (
            record.startLatitude
        ) {

            document.getElementById(
                "locationStatus"
            ).textContent =
                `${record.startLatitude.toFixed(6)}, ${record.startLongitude.toFixed(6)} ` +
                `(±${Math.round(record.startAccuracy || 0)}m)`;

        }

    }


    let workingMinutes = 0;


    if (
        record &&
        record.startTime
    ) {

        if (
            record.endTime
        ) {

            workingMinutes =
                record.totalWorkMinutes;

        } else {

            workingMinutes =
                calculateMinutes(
                    record.startTime,
                    new Date().toISOString()
                );

        }

    }


    document.getElementById(
        "workingTime"
    ).textContent =
        formatMinutes(
            workingMinutes
        );


    const pendingLeaves =
        leaves.filter(
            item =>
                item.employeeId ===
                    currentUser.id &&
                item.status ===
                    "PENDING"
        ).length;


    document.getElementById(
        "pendingLeaveCount"
    ).textContent =
        pendingLeaves;


    const month =
        todayString()
            .substring(0, 7);


    const present =
        attendance.filter(
            item =>
                item.employeeId ===
                    currentUser.id &&
                item.workDate.startsWith(
                    month
                ) &&
                (
                    item.status ===
                        "COMPLETED" ||
                    item.status ===
                        "AUTO_CLOSED"
                )
        ).length;


    document.getElementById(
        "monthlyPresent"
    ).textContent =
        `${present} Days`;


    renderRecentAttendance();

}


/* =====================================================
   RECENT ATTENDANCE
===================================================== */

function renderRecentAttendance() {

    const container =
        document.getElementById(
            "recentAttendance"
        );


    const records =
        attendance
            .filter(
                item =>
                    item.employeeId ===
                    currentUser.id
            )
            .sort(
                (a, b) =>
                    b.workDate.localeCompare(
                        a.workDate
                    )
            )
            .slice(0, 5);


    if (
        records.length === 0
    ) {

        container.innerHTML =
            `<div class="empty-row">
                No attendance records.
             </div>`;

        return;
    }


    container.innerHTML =
        records.map(
            record => `

            <div class="leave-item">

                <div class="leave-item-header">

                    <strong>
                        ${formatDate(
                            record.workDate
                        )}
                    </strong>

                    <span class="status-badge blue">
                        ${record.status}
                    </span>

                </div>

                <p>
                    Start:
                    ${formatTime(
                        record.startTime
                    )}
                    &nbsp; | &nbsp;
                    End:
                    ${formatTime(
                        record.endTime
                    )}
                </p>

                <p>
                    Working Time:
                    ${formatMinutes(
                        record.totalWorkMinutes || 0
                    )}
                </p>

            </div>
        `
        ).join("");

}


/* =====================================================
   ATTENDANCE TABLE
===================================================== */



function renderAttendanceTable() {
    const body = document.getElementById("attendanceTableBody");

    if (!body || !currentUser) return;

    const table = body.closest("table");
    if (!table) return;

    const isAdmin =
        String(currentUser.role || "").toUpperCase() === "ADMIN";

    const today = todayString();

    // Keep employee dashboard restricted to their own records.
    if (!isAdmin) {
        const headerRow = table.querySelector("thead tr");

        if (headerRow) {
            headerRow.innerHTML = `
                <th>Date</th>
                <th>Start Time</th>
                <th>End Time</th>
                <th>Working Time</th>
                <th>Start Location</th>
                <th>Status</th>
            `;
        }

        const myRecords = attendance
            .filter(record =>
                String(record.employeeId) === String(currentUser.id)
            )
            .sort((a, b) =>
                (b.workDate || "").localeCompare(a.workDate || "")
            );

        if (!myRecords.length) {
            body.innerHTML = `
                <tr><td colspan="6" class="empty-row">
                    No attendance records found.
                </td></tr>`;
            return;
        }

        body.innerHTML = myRecords.map(record => `
            <tr>
                <td>${formatDate(record.workDate)}</td>
                <td>${formatTime(record.startTime)}</td>
                <td>${formatTime(record.endTime)}</td>
                <td>${formatMinutes(record.totalWorkMinutes || 0)}</td>
                <td>${record.startLatitude != null &&
                      record.startLongitude != null
                    ? Number(record.startLatitude).toFixed(5) + ", " +
                      Number(record.startLongitude).toFixed(5)
                    : "-"}</td>
                <td>
                    <span class="status-badge blue">
                        ${record.status || "-"}
                    </span>
                </td>
            </tr>
        `).join("");

        return;
    }

    // ADMIN FILTERS
    let filterBox = document.getElementById("adminAttendanceFilters");

    if (!filterBox) {
        filterBox = document.createElement("div");
        filterBox.id = "adminAttendanceFilters";
        filterBox.style.cssText =
            "display:flex;flex-wrap:wrap;gap:12px;" +
            "align-items:end;margin:0 0 16px;padding:14px;" +
            "border:1px solid #ddd;border-radius:10px;";

        filterBox.innerHTML = `
            <div>
                <label for="adminFromDate"><strong>From Date</strong></label><br>
                <input type="date" id="adminFromDate">
            </div>

            <div>
                <label for="adminToDate"><strong>To Date</strong></label><br>
                <input type="date" id="adminToDate">
            </div>

            <div>
                <label for="adminEmployeeFilter"><strong>Employee</strong></label><br>
                <select id="adminEmployeeFilter">
                    <option value="all">All Employees</option>
                </select>
            </div>

            <div>
                <label for="adminStatusFilter"><strong>Status</strong></label><br>
                <select id="adminStatusFilter">
                    <option value="all">All Statuses</option>
                    <option value="present">Present</option>
                    <option value="active">Active</option>
                    <option value="absent">Absent / No Record</option>
                    <option value="leave">On Leave</option>
                </select>
            </div>

            <button type="button" id="adminApplyAttendanceFilters"
                    class="secondary-btn">Apply Filters</button>

            <button type="button" id="adminResetAttendanceFilters"
                    class="secondary-btn">Reset</button>
        `;

        table.parentNode.insertBefore(filterBox, table);

        document.getElementById("adminFromDate").value = today;
        document.getElementById("adminToDate").value = today;

        // Fill the employee dropdown from the existing employees array.
        const employeeSelect =
            document.getElementById("adminEmployeeFilter");

        [...(employees || [])]
            .sort((a, b) =>
                (a.name || "").localeCompare(b.name || "")
            )
            .forEach(employee => {
                const option = document.createElement("option");
                option.value = String(employee.id);
                option.textContent =
                    `${employee.name || "Unnamed Employee"} (${employee.id})`;
                employeeSelect.appendChild(option);
            });

        document.getElementById("adminApplyAttendanceFilters")
            .addEventListener("click", renderAttendanceTable);

        document.getElementById("adminResetAttendanceFilters")
            .addEventListener("click", () => {
                document.getElementById("adminFromDate").value = today;
                document.getElementById("adminToDate").value = today;
                document.getElementById("adminEmployeeFilter").value = "all";
                document.getElementById("adminStatusFilter").value = "all";
                renderAttendanceTable();
            });
    }

    const fromDate =
        document.getElementById("adminFromDate").value || today;

    const toDate =
        document.getElementById("adminToDate").value || today;

    const selectedEmployee =
        document.getElementById("adminEmployeeFilter").value || "all";

    const selectedStatus =
        document.getElementById("adminStatusFilter").value || "all";

    const headerRow = table.querySelector("thead tr");

    if (headerRow) {
        headerRow.innerHTML = `
            <th>Date</th>
            <th>Employee ID</th>
            <th>Employee Name</th>
            <th>Start Time</th>
            <th>End Time</th>
            <th>Working Time</th>
            <th>Start Location</th>
            <th>End Location</th>
            <th>Status</th>
            <th>Route</th>
        `;
    }

    if (fromDate > toDate) {
        body.innerHTML = `
            <tr><td colspan="10" class="empty-row">
                From Date cannot be after To Date.
            </td></tr>`;
        return;
    }

    // Build a date list using UTC to avoid timezone date shifts.
    const dates = [];
    const cursor = new Date(fromDate + "T00:00:00Z");
    const lastDate = new Date(toDate + "T00:00:00Z");

    while (cursor <= lastDate) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);

        // Prevent accidental rendering of an excessively large range.
        if (dates.length > 366) {
            body.innerHTML = `
                <tr><td colspan="10" class="empty-row">
                    Please select a date range of 366 days or less.
                </td></tr>`;
            return;
        }
    }

    // Create one row for every employee for every selected date.
    // Employees with no attendance record are included too.
    const employeeList = (employees || []).filter(employee =>
        selectedEmployee === "all" ||
        String(employee.id) === String(selectedEmployee)
    );

    const rows = [];

    for (const date of dates) {
        for (const employee of employeeList) {
            const record = attendance.find(item =>
                String(item.employeeId ?? item.employee_id) ===
                    String(employee.id) &&
                (item.workDate || item.work_date) === date
            );

            const approvedLeave = (leaves || []).some(leave => {
                const employeeId = leave.employeeId ?? leave.employee_id;
                const start = leave.startDate ?? leave.start_date;
                const end = leave.endDate ?? leave.end_date;
                const leaveStatus = String(leave.status || "").toUpperCase();

                return String(employeeId) === String(employee.id) &&
                    start <= date &&
                    end >= date &&
                    leaveStatus === "APPROVED";
            });

            let displayStatus;
            if (record) {
                displayStatus = String(record.status || "PRESENT").toUpperCase();

                if (displayStatus === "COMPLETED" ||
                    displayStatus === "AUTO_CLOSED") {
                    displayStatus = "PRESENT";
                } else if (displayStatus === "LEAVE") {
                    displayStatus = "ON LEAVE";
                }
            } else if (approvedLeave) {
                displayStatus = "ON LEAVE";
            } else {
                displayStatus = "ABSENT / NO RECORD";
            }

            const normalizedStatus = displayStatus.toLowerCase();

            if (selectedStatus === "present" &&
                displayStatus !== "PRESENT") continue;

            if (selectedStatus === "active" &&
                displayStatus !== "ACTIVE") continue;

            if (selectedStatus === "absent" &&
                displayStatus !== "ABSENT / NO RECORD") continue;

            if (selectedStatus === "leave" &&
                displayStatus !== "ON LEAVE") continue;

            rows.push({
                date,
                employee,
                record,
                displayStatus
            });
        }
    }

    rows.sort((a, b) =>
        b.date.localeCompare(a.date) ||
        (a.employee.name || "").localeCompare(b.employee.name || "")
    );

    // Escape text inserted into HTML.
    const escapeText = value => String(value ?? "-").replace(
        /[&<>"']/g,
        char => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[char]
    );

    const coordinate = (lat, lng) => {
        if (lat == null || lng == null) return "-";

        const latitude = Number(lat);
        const longitude = Number(lng);

        if (!Number.isFinite(latitude) ||
            !Number.isFinite(longitude)) return "-";

        return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    };

    if (!rows.length) {
        body.innerHTML = `
            <tr><td colspan="10" class="empty-row">
                No employees or attendance records match these filters.
            </td></tr>`;
        return;
    }

    body.innerHTML = rows.map(({ date, employee, record, displayStatus }) => {
        const startLocation = record
            ? coordinate(
                record.startLatitude ?? record.start_latitude,
                record.startLongitude ?? record.start_longitude
            )
            : "-";

        const endLocation = record
            ? coordinate(
                record.endLatitude ?? record.end_latitude,
                record.endLongitude ?? record.end_longitude
            )
            : "-";

        const startTime = record
            ? formatTime(record.startTime ?? record.start_time)
            : "-";

        const endTime = record
            ? formatTime(record.endTime ?? record.end_time)
            : "-";

        const workMinutes = record
            ? formatMinutes(
                record.totalWorkMinutes ?? record.total_work_minutes ?? 0
            )
            : "-";

        const routeButton = record
            ? `<button type="button"
                       class="secondary-btn"
                       data-route-attendance="${escapeText(record.id)}">
                   View Route
               </button>`
            : "-";

        return `
            <tr>
                <td>${escapeText(formatDate(date))}</td>
                <td>${escapeText(employee.id)}</td>
                <td>${escapeText(employee.name || "Unnamed Employee")}</td>
                <td>${escapeText(startTime)}</td>
                <td>${escapeText(endTime)}</td>
                <td>${escapeText(workMinutes)}</td>
                <td>${escapeText(startLocation)}</td>
                <td>${escapeText(endLocation)}</td>
                <td>
                    <span class="status-badge blue">
                        ${escapeText(displayStatus)}
                    </span>
                </td>
                <td>${routeButton}</td>
            </tr>
        `;
    }).join("");

    // Attach route buttons to the existing GPS route function.
    body.querySelectorAll("[data-route-attendance]").forEach(button => {
        button.addEventListener("click", () => {
            openAttendanceMap(button.dataset.routeAttendance);
        });
    });
}


/* =====================================================
   MY LEAVE
===================================================== */

function renderMyLeaves() {

    const container =
        document.getElementById(
            "myLeaveList"
        );


    const myLeaves =
        leaves
            .filter(
                item =>
                    item.employeeId ===
                    currentUser.id
            )
            .sort(
                (a, b) =>
                    b.appliedDate.localeCompare(
                        a.appliedDate
                    )
            );


    if (
        myLeaves.length === 0
    ) {

        container.innerHTML =
            `<div class="empty-row">
                No leave requests.
             </div>`;

        return;
    }


    container.innerHTML =
        myLeaves.map(
            leave => `

            <div class="leave-item">

                <div class="leave-item-header">

                    <strong>
                        ${escapeHtml(
                            leave.leaveType
                        )}
                    </strong>

                    <span class="status-badge ${
                        leave.status ===
                        "APPROVED"
                            ? "green"
                            : leave.status ===
                              "REJECTED"
                            ? "red"
                            : "orange"
                    }">
                        ${leave.status}
                    </span>

                </div>

                <p>
                    ${formatDate(
                        leave.startDate
                    )}
                    →
                    ${formatDate(
                        leave.endDate
                    )}
                </p>

                <p>
                    ${escapeHtml(
                        leave.reason
                    )}
                </p>

                ${
                    leave.isBackdated
                        ? `
                        <p>
                            ⚠ Backdated Request
                        </p>
                        `
                        : ""
                }

                ${
                    leave.adminComment
                        ? `
                        <p>
                            Admin:
                            ${escapeHtml(
                                leave.adminComment
                            )}
                        </p>
                        `
                        : ""
                }

            </div>

        `
        ).join("");

}


/* =====================================================
   ADMIN LEAVE TABLE
===================================================== */

function renderAdminLeaves() {

    const body =
        document.getElementById(
            "adminLeaveTableBody"
        );


    if (
        currentUser.role !==
        "ADMIN"
    ) {

        return;
    }


    if (
        leaves.length === 0
    ) {

        body.innerHTML =
            `<tr>
                <td colspan="7"
                    class="empty-row">
                    No leave requests.
                </td>
             </tr>`;

        return;
    }


    body.innerHTML =
        leaves.map(
            leave => `

            <tr>

                <td>
                    ${escapeHtml(
                        leave.employeeName
                    )}
                </td>

                <td>
                    ${escapeHtml(
                        leave.leaveType
                    )}
                </td>

                <td>
                    ${formatDate(
                        leave.startDate
                    )}
                    →
                    ${formatDate(
                        leave.endDate
                    )}
                </td>

                <td>
                    ${escapeHtml(
                        leave.reason
                    )}
                </td>

                <td>
                    ${formatDate(
                        leave.appliedDate
                    )}
                </td>

                <td>
                    <span class="status-badge ${
                        leave.status ===
                        "APPROVED"
                            ? "green"
                            : leave.status ===
                              "REJECTED"
                            ? "red"
                            : "orange"
                    }">
                        ${leave.status}
                    </span>
                </td>

                <td>

                    ${
                        leave.status ===
                        "PENDING"

                            ? `

                            <button
                                class="success-btn"
                                onclick="approveLeave('${leave.id}')"
                            >
                                Approve
                            </button>

                            <button
                                class="danger-btn"
                                onclick="rejectLeave('${leave.id}')"
                            >
                                Reject
                            </button>

                            `

                            : "-"

                    }

                </td>

            </tr>

        `
        ).join("");

}


/* =====================================================
   EMPLOYEE TABLE
===================================================== */

function renderEmployees() {

    const body =
        document.getElementById(
            "employeesTableBody"
        );


    if (!body) {
        return;
    }


    /*
     * IMPORTANT:
     *
     * Employee page uses the employees array,
     * NOT the users array.
     *
     * users = Admin + Employee login accounts
     * employees = Employee profiles only
     */

    if (
        employees.length === 0
    ) {

        body.innerHTML = `
            <tr>
                <td colspan="7" class="empty-row">
                    No employees found.
                </td>
            </tr>
        `;

        return;
    }


    body.innerHTML =
        employees.map(
            employee => {

                /*
                 * Find the matching login account
                 * using the shared employee ID.
                 */

                const user =
                    users.find(
                        item =>
                            item.id ===
                            employee.id
                    );


                return `

                <tr>

                    <td>
                        ${escapeHtml(
                            employee.id
                        )}
                    </td>

                    <td>
                        ${escapeHtml(
                            employee.name
                        )}
                    </td>

                    <td>
                        ${escapeHtml(
                            employee.email
                        )}
                    </td>

                    <td>
                        ${escapeHtml(
                            employee.department
                        )}
                    </td>

                    <td>
                        ${
                            user
                                ? escapeHtml(
                                    user.role
                                )
                                : "EMPLOYEE"
                        }
                    </td>

                    <td>
                        <span class="status-badge green">
                            ${escapeHtml(
                                employee.status
                            )}
                        </span>
                    </td>

                    <td>

                        <button
                            class="secondary-btn"
                            onclick="editEmployee('${employee.id}')"
                        >
                            Edit
                        </button>

                        <button
                            class="danger-btn"
                            onclick="deleteEmployee('${employee.id}')"
                        >
                            Delete
                        </button>

                    </td>

                </tr>

                `;

            }
        ).join("");

}


/* =====================================================
   REPORT EMPLOYEE DROPDOWN
===================================================== */

function renderReportEmployees() {

    const select =
        document.getElementById(
            "reportEmployee"
        );


    const current =
        select.value;


    select.innerHTML =
        `<option value="all">
            All Employees
         </option>`;


    employees.forEach(
        employee => {

            select.innerHTML +=
                `<option value="${employee.id}">
                    ${escapeHtml(
                        employee.name
                    )}
                 </option>`;

        }
    );


    select.value =
        current || "all";

}


/* =====================================================
   EXPORT CSV
===================================================== */

function convertToCSV(
    rows
) {

    return rows
        .map(
            row =>
                row.map(
                    value =>
                        `"${String(
                            value ?? ""
                        ).replaceAll(
                            '"',
                            '""'
                        )}"`
                ).join(",")
        )
        .join("\n");

}


function downloadCSV(
    filename,
    rows
) {

    const csv =
        convertToCSV(rows);

    const blob =
        new Blob(
            [csv],
            {
                type:
                    "text/csv;charset=utf-8;"
            }
        );


    const url =
        URL.createObjectURL(
            blob
        );


    const link =
        document.createElement(
            "a"
        );

    link.href =
        url;

    link.download =
        filename;

    link.click();


    URL.revokeObjectURL(
        url
    );

}



/* =====================================================
   ATTENDANCE PAGE EXPORT (Respects Table Filters)
===================================================== */

function getFilteredAttendanceTableRows() {
    const isAdmin = String(currentUser.role || "").toUpperCase() === "ADMIN";
    const today = todayString();

    if (!isAdmin) {
        // Regular employee exports only their own records
        return attendance
            .filter(record => String(record.employeeId) === String(currentUser.id))
            .map(record => ({
                date: record.workDate,
                employeeId: currentUser.id,
                employeeName: currentUser.name,
                startTime: formatTime(record.startTime),
                endTime: formatTime(record.endTime),
                workingTime: formatMinutes(record.totalWorkMinutes || 0),
                startLocation: record.startLatitude != null ? `${Number(record.startLatitude).toFixed(5)}, ${Number(record.startLongitude).toFixed(5)}` : "-",
                status: record.status || "-"
            }));
    }

    // Admin filters
    const fromDate = document.getElementById("adminFromDate")?.value || today;
    const toDate = document.getElementById("adminToDate")?.value || today;
    const selectedEmployee = document.getElementById("adminEmployeeFilter")?.value || "all";
    const selectedStatus = document.getElementById("adminStatusFilter")?.value || "all";

    // Build date list
    const dates = [];
    const cursor = new Date(fromDate + "T00:00:00Z");
    const lastDate = new Date(toDate + "T00:00:00Z");

    while (cursor <= lastDate) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        if (dates.length > 366) break;
    }

    const employeeList = (employees || []).filter(emp =>
        selectedEmployee === "all" || String(emp.id) === String(selectedEmployee)
    );

    const rows = [];

    dates.forEach(date => {
        employeeList.forEach(employee => {
            const record = attendance.find(item =>
                String(item.employeeId ?? item.employee_id) === String(employee.id) &&
                (item.workDate || item.work_date) === date
            );

            const approvedLeave = (leaves || []).some(leave => {
                const empId = leave.employeeId ?? leave.employee_id;
                const start = leave.startDate ?? leave.start_date;
                const end = leave.endDate ?? leave.end_date;
                return String(empId) === String(employee.id) &&
                    start <= date &&
                    end >= date &&
                    String(leave.status || "").toUpperCase() === "APPROVED";
            });

            let displayStatus;
            if (record) {
                displayStatus = String(record.status || "PRESENT").toUpperCase();
                if (displayStatus === "COMPLETED" || displayStatus === "AUTO_CLOSED") {
                    displayStatus = "PRESENT";
                } else if (displayStatus === "LEAVE") {
                    displayStatus = "ON LEAVE";
                }
            } else if (approvedLeave) {
                displayStatus = "ON LEAVE";
            } else {
                displayStatus = "ABSENT / NO RECORD";
            }

            const normalizedStatus = displayStatus.toLowerCase();

            if (selectedStatus === "present" && displayStatus !== "PRESENT") return;
            if (selectedStatus === "active" && displayStatus !== "ACTIVE") return;
            if (selectedStatus === "absent" && displayStatus !== "ABSENT / NO RECORD") return;
            if (selectedStatus === "leave" && displayStatus !== "ON LEAVE") return;

            rows.push({
                date,
                employeeId: employee.id,
                employeeName: employee.name || "Unnamed Employee",
                startTime: record ? formatTime(record.startTime ?? record.start_time) : "-",
                endTime: record ? formatTime(record.endTime ?? record.end_time) : "-",
                workingTime: record ? formatMinutes(record.totalWorkMinutes ?? record.total_work_minutes ?? 0) : "-",
                startLocation: record && record.startLatitude != null ? `${Number(record.startLatitude).toFixed(5)}, ${Number(record.startLongitude).toFixed(5)}` : "-",
                endLocation: record && record.endLatitude != null ? `${Number(record.endLatitude).toFixed(5)}, ${Number(record.endLongitude).toFixed(5)}` : "-",
                status: displayStatus
            });
        });
    });

    return rows;
}

document
    .getElementById("exportAttendanceBtn")
    .addEventListener("click", function () {
        const records = getFilteredAttendanceTableRows();

        if (records.length === 0) {
            showToast("No attendance records match the current filters.");
            return;
        }

        const rows = [
            [
                "Date",
                "Employee ID",
                "Employee Name",
                "Start Time",
                "End Time",
                "Working Time",
                "Start Location",
                "End Location",
                "Status"
            ]
        ];

        records.forEach(record => {
            rows.push([
                record.date,
                record.employeeId,
                record.employeeName,
                record.startTime,
                record.endTime,
                record.workingTime,
                record.startLocation,
                record.endLocation || "-",
                record.status
            ]);
        });

        downloadCSV(
            `attendance_history_${todayString()}.csv`,
            rows
        );

        showToast("Attendance history exported successfully.");
    });
/* =====================================================
   ADMIN REPORT & FILTERED EXPORT
===================================================== */

document
    .getElementById(
        "generateReportBtn"
    )
    .addEventListener(
        "click",
        generateReport
    );

// Helper to generate all dates in a selected range
function getDatesInRange(startDate, endDate) {
    const dates = [];
    let currentDate = new Date(startDate + "T00:00:00Z");
    const stopDate = new Date(endDate + "T00:00:00Z");
    
    while (currentDate <= stopDate) {
        dates.push(currentDate.toISOString().slice(0, 10));
        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }
    return dates;
}

function getFilteredReportData() {
    const from = document.getElementById("reportFrom").value || todayString();
    const to = document.getElementById("reportTo").value || todayString();
    const selectedEmployee = document.getElementById("reportEmployee").value;

    const targetEmployees = selectedEmployee === "all"
        ? employees
        : employees.filter(emp => emp.id === selectedEmployee);

    const dateRange = getDatesInRange(from, to);
    const reportRows = [];

    dateRange.forEach(date => {
        targetEmployees.forEach(emp => {
            const record = attendance.find(item =>
                String(item.employeeId ?? item.employee_id) === String(emp.id) &&
                (item.workDate || item.work_date) === date
            );

            const approvedLeave = (leaves || []).some(leave => {
                const empId = leave.employeeId ?? leave.employee_id;
                const start = leave.startDate ?? leave.start_date;
                const end = leave.endDate ?? leave.end_date;
                return String(empId) === String(emp.id) &&
                    start <= date &&
                    end >= date &&
                    String(leave.status || "").toUpperCase() === "APPROVED";
            });

            let status = "ABSENT / NOT PUNCHED";
            let startTime = "-";
            let endTime = "-";
            let workMinutes = 0;
            let startLat = "-";
            let startLng = "-";
            let endLat = "-";
            let endLng = "-";
            let endType = "-";

            if (record) {
                status = String(record.status || "PRESENT").toUpperCase();
                startTime = formatTime(record.startTime ?? record.start_time);
                endTime = formatTime(record.endTime ?? record.end_time);
                workMinutes = record.totalWorkMinutes ?? record.total_work_minutes ?? 0;
                startLat = record.startLatitude ?? record.start_latitude ?? "-";
                startLng = record.startLongitude ?? record.start_longitude ?? "-";
                endLat = record.endLatitude ?? record.end_latitude ?? "-";
                endLng = record.endLongitude ?? record.end_longitude ?? "-";
                endType = record.endType ?? record.end_type ?? "-";
            } else if (approvedLeave) {
                status = "ON LEAVE";
            }

            reportRows.push({
                date,
                employeeId: emp.id,
                employeeName: emp.name || "Unnamed Employee",
                startTime,
                endTime,
                workingMinutes: workMinutes,
                startLatitude: startLat,
                startLongitude: startLng,
                endLatitude: endLat,
                endLongitude: endLng,
                status,
                endType
            });
        });
    });

    return reportRows;
}

function generateReport() {
    const records = getFilteredReportData();
    const container = document.getElementById("reportResult");

    container.innerHTML = `
        <div class="section-card">
            <h3>Report Result</h3>
            <p>Total filtered entries generated (including absences/leaves): <strong>${records.length}</strong></p>
        </div>
    `;
}

document
    .getElementById(
        "exportReportBtn"
    )
    .addEventListener(
        "click",
        function () {
            const records = getFilteredReportData();

            if (records.length === 0) {
                showToast("No data available for the selected filters.");
                return;
            }

            const rows = [
                [
                    "Date",
                    "Employee Code",
                    "Employee Name",
                    "Start Time",
                    "End Time",
                    "Working Minutes",
                    "Start Latitude",
                    "Start Longitude",
                    "End Latitude",
                    "End Longitude",
                    "Status",
                    "End Type"
                ]
            ];

            records.forEach(record => {
                rows.push([
                    record.date,
                    record.employeeId,
                    record.employeeName,
                    record.startTime,
                    record.endTime,
                    record.workingMinutes,
                    record.startLatitude,
                    record.startLongitude,
                    record.endLatitude,
                    record.endLongitude,
                    record.status,
                    record.endType
                ]);
            });

            downloadCSV(
                `attendance_report_${todayString()}.csv`,
                rows
            );

            showToast("Filtered report downloaded successfully.");
        }
    );
/* =====================================================
   SETTINGS
===================================================== */

document
    .getElementById("saveSettingsBtn")
    .addEventListener(
        "click",
        async function () {

            settings.autoCloseTime =
                document.getElementById(
                    "autoCloseTime"
                ).value || "23:59";


            settings.locationInterval =
                Number(
                    document.getElementById(
                        "locationInterval"
                    ).value
                ) || 5;


            settings.requireLocation =
                document.getElementById(
                    "requireLocation"
                ).value === "true";


            settings.allowBackdatedLeave =
                document.getElementById(
                    "allowBackdatedLeave"
                ).value === "true";


            const {
                data: existing,
                error: findError
            } = await supabaseClient
                .from("system_settings")
                .select("id")
                .limit(1)
                .maybeSingle();


            if (findError) {

                console.error(
                    "Settings lookup error:",
                    findError
                );

                showToast(
                    "Failed to load system settings."
                );

                return;
            }


            let result;


            if (existing) {

                result =
                    await supabaseClient
                        .from("system_settings")
                        .update({

                            auto_close_time:
                                settings.autoCloseTime,

                            location_interval:
                                settings.locationInterval,

                            require_location:
                                settings.requireLocation,

                            allow_backdated_leave:
                                settings.allowBackdatedLeave

                        })
                        .eq(
                            "id",
                            existing.id
                        )
                        .select()
                        .single();

            } else {

                result =
                    await supabaseClient
                        .from("system_settings")
                        .insert([{

                            auto_close_time:
                                settings.autoCloseTime,

                            location_interval:
                                settings.locationInterval,

                            require_location:
                                settings.requireLocation,

                            allow_backdated_leave:
                                settings.allowBackdatedLeave

                        }])
                        .select()
                        .single();

            }


            if (result.error) {

                console.error(
                    "Settings save error:",
                    result.error
                );

                showToast(
                    "Failed to save settings: " +
                    result.error.message
                );

                return;
            }


            showToast(
                "Settings saved successfully."
            );

            renderSettings();

        }
    );



/* =====================================================
   RENDER SETTINGS
===================================================== */

function renderSettings() {

    const autoClose =
        document.getElementById(
            "autoCloseTime"
        );

    const locationInterval =
        document.getElementById(
            "locationInterval"
        );

    const requireLocation =
        document.getElementById(
            "requireLocation"
        );

    const allowBackdatedLeave =
        document.getElementById(
            "allowBackdatedLeave"
        );


    if (autoClose) {

        autoClose.value =
            settings.autoCloseTime;

    }


    if (locationInterval) {

        locationInterval.value =
            String(
                settings.locationInterval
            );

    }


    if (requireLocation) {

        requireLocation.value =
            String(
                settings.requireLocation
            );

    }


    if (allowBackdatedLeave) {

        allowBackdatedLeave.value =
            String(
                settings.allowBackdatedLeave
            );

    }

}

/* =====================================================
   EDIT EMPLOYEE
===================================================== */

async function editEmployee(id) {

    const employee =
        employees.find(
            item =>
                item.id === id
        );

    const user =
        users.find(
            item =>
                item.id === id
        );

    if (
        !employee ||
        !user
    ) {
        showToast(
            "Employee account could not be found."
        );
        return;
    }

    const name =
        prompt(
            "Employee name:",
            employee.name
        );

    if (
        name === null
    ) {
        return;
    }

    const email =
        prompt(
            "Employee email:",
            employee.email
        );

    if (
        email === null
    ) {
        return;
    }

    const department =
        prompt(
            "Department:",
            employee.department
        );

    if (
        department === null
    ) {
        return;
    }

    const updatedName =
        name.trim();

    const updatedEmail =
        email.trim().toLowerCase();

    const updatedDepartment =
        department.trim();

    if (
        !updatedName ||
        !updatedEmail
    ) {
        showToast(
            "Name and email are required."
        );
        return;
    }

    const duplicateUser =
        users.find(
            item =>
                item.id !== id &&
                item.email.toLowerCase() ===
                    updatedEmail
        );

    if (duplicateUser) {
        showToast(
            "Another user with this email already exists."
        );
        return;
    }

    /*
     * Update employee table in Supabase
     */
    const {
        data: updatedEmployee,
        error: employeeError
    } = await supabaseClient
        .from("employees")
        .update({
            name: updatedName,
            email: updatedEmail,
            department: updatedDepartment
        })
        .eq("id", id)
        .select()
        .single();

    if (employeeError) {

        console.error(
            "Employee update error:",
            employeeError
        );

        showToast(
            "Failed to update employee: " +
            employeeError.message
        );

        return;
    }

    /*
     * Update users table in Supabase
     */
    const {
        data: updatedUser,
        error: userError
    } = await supabaseClient
        .from("users")
        .update({
            name: updatedName,
            email: updatedEmail
        })
        .eq("id", id)
        .select()
        .single();

    if (userError) {

        console.error(
            "User update error:",
            userError
        );

        /*
         * Reload employee data so local
         * screen matches database.
         */
        await loadEmployeesFromDatabase();
        await loadUsersFromDatabase();

        showToast(
            "Employee updated partially. User update failed: " +
            userError.message
        );

        renderAll();

        return;
    }

    /*
     * Update local arrays only after
     * Supabase update succeeds.
     */
    employee.name =
        updatedEmployee.name;

    employee.email =
        updatedEmployee.email;

    employee.department =
        updatedEmployee.department;

    user.name =
        updatedUser.name;

    user.email =
        updatedUser.email;

    /*
     * If the currently logged-in user
     * was edited, update the session too.
     */
    if (
        currentUser &&
        currentUser.id === id
    ) {

        currentUser =
            user;

        localStorage.setItem(
            "sales_current_user",
            JSON.stringify(
                currentUser
            )
        );
    }

    showToast(
        "Employee updated successfully."
    );

    renderAll();
}

/* =====================================================
   DELETE EMPLOYEE
===================================================== */

async function deleteEmployee(id) {

    const employee =
        employees.find(
            item =>
                item.id === id
        );


    const user =
        users.find(
            item =>
                item.id === id
        );


    if (!employee) {

        showToast(
            "Employee not found."
        );

        return;
    }


    const confirmDelete =
        confirm(
            `Delete ${employee.name} (${employee.id})?`
        );


    if (!confirmDelete) {
        return;
    }


    /* =================================================
       DELETE EMPLOYEE PROFILE FROM SUPABASE
    ================================================= */

    const {
        error: employeeError
    } = await supabaseClient
        .from("employees")
        .delete()
        .eq("id", id);


    if (employeeError) {

        console.error(
            "Employee delete error:",
            employeeError
        );

        showToast(
            "Failed to delete employee: " +
            employeeError.message
        );

        return;
    }


    /* =================================================
       DELETE LOGIN USER FROM SUPABASE
    ================================================= */

    if (user) {

        const {
            error: userError
        } = await supabaseClient
            .from("users")
            .delete()
            .eq("id", id);


        if (userError) {

            console.error(
                "User delete error:",
                userError
            );


            /*
             * Reload employee data so the
             * local screen matches Supabase.
             */

            await loadEmployeesFromDatabase();
            await loadUsersFromDatabase();


            showToast(
                "Employee profile deleted, but login account could not be deleted: " +
                userError.message
            );


            renderAll();

            return;
        }

    }


    /* =================================================
       REMOVE FROM LOCAL MEMORY
       ONLY AFTER SUPABASE DELETE SUCCEEDS
    ================================================= */

    employees =
        employees.filter(
            item =>
                item.id !== id
        );


    users =
        users.filter(
            item =>
                item.id !== id
        );


    /* =================================================
       IF CURRENT USER WAS DELETED
    ================================================= */

    if (
        currentUser &&
        currentUser.id === id
    ) {

        currentUser = null;


        localStorage.removeItem(
            "sales_current_user"
        );


        appScreen.classList.add(
            "hidden"
        );


        loginScreen.classList.remove(
            "hidden"
        );


        loginForm.reset();


        showToast(
            "Employee deleted."
        );


        return;
    }


    /* =================================================
       SUCCESS
    ================================================= */

    showToast(
        "Employee deleted successfully."
    );


    renderAll();

}


/* =====================================================
   PASSWORD TOGGLE
===================================================== */

function togglePassword() {

    const password =
        document.getElementById(
            "employeePassword"
        );

    const button =
        document.querySelector(
            ".show-password"
        );


    if (
        password.type ===
        "password"
    ) {

        password.type =
            "text";

        button.textContent =
            "Hide";

    } else {

        password.type =
            "password";

        button.textContent =
            "Show";

    }

}


/* =====================================================
   GET EMPLOYEE PASSWORD
===================================================== */

function getEmployeePassword(
    employeeId
) {

    const user =
        users.find(
            user =>
                user.id ===
                employeeId
        );


    return user
        ? user.password
        : "-";

}


/* =====================================================
   RENDER EVERYTHING
===================================================== */

function renderAll() {

    if (!currentUser) {
        return;
    }


    renderDashboard();

    renderAttendanceTable();

    renderMyLeaves();


    if (
        currentUser.role ===
        "ADMIN"
    ) {

        renderAdminLeaves();

        renderEmployees();

        renderReportEmployees();

        renderSettings();
        renderAdminUsers();

    }

}


/* =====================================================
   AUTO UPDATE
===================================================== */

setInterval(
    function () {

        if (
            currentUser
        ) {

            runAutoCloseCheck();

            renderDashboard();

        }

    },
    30000
);



function renderAdminUsers() {

    const body =
        document.getElementById("adminUsersTableBody");

    const admins =
        users.filter(
            user => user.role === "ADMIN"
        );

    if (admins.length === 0) {

        body.innerHTML = `
            <tr>
                <td colspan="4">
                    No admin users found.
                </td>
            </tr>
        `;

        return;
    }

    body.innerHTML =
        admins.map(
            admin => `
                <tr>
                    <td>${escapeHtml(admin.id)}</td>
                    <td>${escapeHtml(admin.name)}</td>
                    <td>${escapeHtml(admin.email)}</td>
                    <td>${escapeHtml(admin.password)}</td>
                    <td>
                        <span class="status-badge green">
                            ADMIN
                        </span>
                    </td>
                <td>
                        <button
                            class="danger-btn"
                            onclick="deleteAdmin('${admin.id}')"
                        >
                            Delete
                        </button>
                    </td>
                </tr>
            `
        ).join("");
}
async function deleteAdmin(id) {

    const admin =
        users.find(
            user =>
                user.id === id &&
                user.role === "ADMIN"
        );


    if (!admin) {

        showToast(
            "Admin user not found."
        );

        return;
    }


    /* =================================================
       PREVENT DELETING YOURSELF
    ================================================= */

    if (
        currentUser &&
        currentUser.id === id
    ) {

        showToast(
            "You cannot delete your own admin account."
        );

        return;
    }


    /* =================================================
       CONFIRM DELETE
    ================================================= */

    const confirmDelete =
        confirm(
            `Delete admin ${admin.name} (${admin.id})?`
        );


    if (!confirmDelete) {
        return;
    }


    /* =================================================
       DELETE ADMIN FROM SUPABASE
    ================================================= */

    const {
        error
    } = await supabaseClient
        .from("users")
        .delete()
        .eq("id", id)
        .eq("role", "ADMIN");


    if (error) {

        console.error(
            "Admin delete error:",
            error
        );

        showToast(
            "Failed to delete admin: " +
            error.message
        );

        return;
    }


    /* =================================================
       REMOVE FROM LOCAL MEMORY
       ONLY AFTER SUPABASE DELETE SUCCEEDS
    ================================================= */

    users =
        users.filter(
            user =>
                user.id !== id
        );


    /* =================================================
       SUCCESS
    ================================================= */

    showToast(
        "Admin deleted successfully."
    );


    renderAll();

}
/* =====================================================
   START APPLICATION
===================================================== */

async function startApplication() {

    await loadDatabaseData();

    checkExistingLogin();

}

startApplication();
async function loadAttendanceLocationsFromDatabase() {
    const { data, error } = await supabaseClient
        .from("attendance_locations")
        .select(
            "id, attendance_id, employee_id, latitude, longitude, accuracy, recorded_at, source"
        )
        .order("recorded_at", { ascending: true });

    if (error) {
        console.error("Could not load location history:", error);
        throw error;
    }

    const locationsByAttendance = new Map();

    for (const row of (data || [])) {
        if (!locationsByAttendance.has(row.attendance_id)) {
            locationsByAttendance.set(row.attendance_id, []);
        }

        locationsByAttendance.get(row.attendance_id).push({
            id: row.id,
            attendanceId: row.attendance_id,
            employeeId: row.employee_id,
            latitude: Number(row.latitude),
            longitude: Number(row.longitude),
            accuracy: row.accuracy,
            recordedAt: row.recorded_at,
            source: row.source
        });
    }

    attendance.forEach(record => {
        record.locations =
            locationsByAttendance.get(record.id) || [];
    });
}
let attendanceMapInstance = null;
let attendanceMapLayer = null;

async function openAttendanceMap(attendanceId) {
    const record = attendance.find(
        item => item.id === attendanceId
    );

    if (!record) {
        showToast("Attendance record not found.");
        return;
    }

    // Employees may only view their own route.
    if (
        currentUser.role !== "ADMIN" &&
        record.employeeId !== currentUser.id
    ) {
        showToast("You cannot view this attendance route.");
        return;
    }

    const modal =
        document.getElementById("attendanceMapModal");

    const info =
        document.getElementById("attendanceMapInfo");

    const list =
        document.getElementById("attendanceLocationList");

    modal.classList.remove("hidden");
    info.textContent = "Loading saved locations...";
    list.innerHTML = "";

    try {
        await loadAttendanceLocationsFromDatabase();
    } catch (error) {
        info.textContent =
            "Could not load location history. Check database permissions.";
        return;
    }

    const savedPoints = (record.locations || [])
        .filter(point =>
            Number.isFinite(Number(point.latitude)) &&
            Number.isFinite(Number(point.longitude))
        )
        .map(point => ({
            latitude: Number(point.latitude),
            longitude: Number(point.longitude),
            accuracy: point.accuracy,
            recordedAt: point.recordedAt || point.timestamp,
            source: point.source
        }))
        .sort((a, b) =>
            new Date(a.recordedAt) - new Date(b.recordedAt)
        );

    // Avoid adding the start/end point twice if it is already
    // present in attendance_locations.
    const points = [...savedPoints];

    function addEndpoint(latitude, longitude, time, label) {
        if (
            latitude == null ||
            longitude == null ||
            !Number.isFinite(Number(latitude)) ||
            !Number.isFinite(Number(longitude))
        ) {
            return;
        }

        const endpoint = {
            latitude: Number(latitude),
            longitude: Number(longitude),
            accuracy: null,
            recordedAt: time,
            source: label
        };

        const duplicate = points.some(point =>
            Math.abs(point.latitude - endpoint.latitude) < 0.000001 &&
            Math.abs(point.longitude - endpoint.longitude) < 0.000001 &&
            Math.abs(
                new Date(point.recordedAt).getTime() -
                new Date(endpoint.recordedAt).getTime()
            ) < 5000
        );

        if (!duplicate) {
            points.push(endpoint);
        }
    }

    addEndpoint(
        record.startLatitude,
        record.startLongitude,
        record.startTime,
        "Start"
    );

    addEndpoint(
        record.endLatitude,
        record.endLongitude,
        record.endTime,
        "End"
    );

    points.sort((a, b) =>
        new Date(a.recordedAt) - new Date(b.recordedAt)
    );

    info.textContent =
        `${formatDate(record.workDate)} · ` +
        `${points.length} recorded location(s) · ` +
        `${record.status}`;

    list.innerHTML = points.length
        ? points.map((point, index) => `
            <div class="location-history-item">
                <strong>${index + 1}. ${escapeHtml(point.source || "Recorded location")}</strong>
                <p>${escapeHtml(
                    point.recordedAt
                        ? new Date(point.recordedAt).toLocaleString()
                        : "Time unavailable"
                )}</p>
                <p>
                    ${point.latitude.toFixed(6)},
                    ${point.longitude.toFixed(6)}
                    ${point.accuracy != null
                        ? `(±${Math.round(point.accuracy)}m)`
                        : ""}
                </p>
            </div>
        `).join("")
        : "<p>No GPS points were saved for this attendance.</p>";

    if (attendanceMapInstance) {
        attendanceMapInstance.remove();
        attendanceMapInstance = null;
    }

    attendanceMapLayer = null;

    attendanceMapInstance = L.map("attendanceMap");

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
    }).addTo(attendanceMapInstance);

    const validPoints = points.map(point => [
        point.latitude,
        point.longitude
    ]);

    if (validPoints.length) {
        attendanceMapLayer = L.featureGroup().addTo(
            attendanceMapInstance
        );

        points.forEach((point, index) => {
            const marker = L.marker([
                point.latitude,
                point.longitude
            ]);

            marker.bindPopup(
                `<strong>${escapeHtml(point.source || "Location point")}</strong><br>` +
                `${escapeHtml(
                    point.recordedAt
                        ? new Date(point.recordedAt).toLocaleString()
                        : "Time unavailable"
                )}<br>` +
                `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`
            );

            marker.addTo(attendanceMapLayer);
        });

        if (validPoints.length > 1) {
            L.polyline(validPoints, {
                color: "#2563eb",
                weight: 4
            }).addTo(attendanceMapLayer);
        }

        attendanceMapInstance.fitBounds(
            attendanceMapLayer.getBounds().pad(0.15),
            { maxZoom: 16 }
        );
    } else {
        // Nepal is only a neutral fallback view, not a claim
        // about the employee's actual location.
        attendanceMapInstance.setView([28.3949, 84.1240], 6);
    }

    setTimeout(() => {
        attendanceMapInstance?.invalidateSize();
    }, 150);
}

document
    .getElementById("closeAttendanceMap")
    .addEventListener("click", () => {
        document
            .getElementById("attendanceMapModal")
            .classList.add("hidden");
    });
    /* =====================================================
   PROFILE DROPDOWN TOGGLE
===================================================== */

const profileTrigger = document.getElementById("profileTrigger");
const profileDropdown = document.getElementById("profileDropdown");

if (profileTrigger && profileDropdown) {
    profileTrigger.addEventListener("click", function (event) {
        event.stopPropagation();
        profileDropdown.classList.toggle("hidden");
    });

    // Close dropdown when clicking anywhere else on the screen
    document.addEventListener("click", function () {
        if (!profileDropdown.classList.contains("hidden")) {
            profileDropdown.classList.add("hidden");
        }
    });

    // Prevent clicks inside the dropdown from closing it instantly
    profileDropdown.addEventListener("click", function (event) {
        event.stopPropagation();
    });
}


/* =====================================================
   PROFILE PHOTO UPLOAD HANDLING
===================================================== */

const profilePhotoInput = document.getElementById("profilePhotoInput");

if (profilePhotoInput) {
    profilePhotoInput.addEventListener("change", function (event) {
        const file = event.target.files[0];
        if (!file) return;

        // Check file size (optional limit to ~2MB for localStorage)
        if (file.size > 2 * 1024 * 1024) {
            showToast("Image size should be less than 2MB.");
            return;
        }

        const reader = new FileReader();
        reader.onload = function (e) {
            const base64Image = e.target.result;

            // Save to localStorage (keyed by current user ID so it's unique per user)
            if (currentUser) {
                localStorage.setItem(`sales_avatar_${currentUser.id}`, base64Image);
            }

            // Update UI
            applyUserAvatar(base64Image);
            showToast("Profile photo updated successfully.");
            
            // Close dropdown
            if (profileDropdown) {
                profileDropdown.classList.add("hidden");
            }
        };
        reader.readAsDataURL(file);
    });
}

function applyUserAvatar(imageSrc) {
    const avatarElement = document.getElementById("userAvatar");
    if (avatarElement) {
        if (imageSrc) {
            avatarElement.style.backgroundImage = `url(${imageSrc})`;
            avatarElement.style.backgroundSize = "cover";
            avatarElement.style.backgroundPosition = "center";
            avatarElement.textContent = ""; // Clear text initial (like 'S' or 'U')
        } else {
            avatarElement.style.backgroundImage = "";
            avatarElement.textContent = currentUser ? currentUser.name.charAt(0).toUpperCase() : "U";
        }
    }
}