import { QueryResult } from "pg"
import { notificationsApi, jobsApi } from "./config/api-config"

const express = require("express")
const cookieParser = require("cookie-parser")
const helmet = require("helmet")
const cors = require("cors")
const cron = require("node-cron")
const db = require("./config/db-config")

const corsOptions = {
    origin: process.env.ORIGIN_URL || process.env.OPENSHIFT_NODEJS_ORIGIN_URL || "https://localhost:8000",
    credentials: true,
    optionsSuccessStatus: 200
}

const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cors(corsOptions))
app.use(cookieParser())
app.use(helmet())

const port = process.env.PORT || "8000"
app.listen(port, () => {
    console.log(`server started at http://localhost:${port}`)
    console.log("Notifications API URL: ", process.env.NOTIFICATIONS_API_URL)
    console.log("Jobs API URL: ", process.env.JOBS_API_URL)
    console.log("PG HOST: ", process.env.PGHOST)
    console.log("PG PORT: ", process.env.PGPORT)
})

cron.schedule("0 8 * * *", async () => {
    console.log("===== START CRON JOB =====")
    const minimumPostedDate = new Date()
    minimumPostedDate.setDate(minimumPostedDate.getDate() - 1)
    minimumPostedDate.setHours(8)
    minimumPostedDate.setMinutes(0)
    minimumPostedDate.setSeconds(0)
    minimumPostedDate.setMilliseconds(0)
    const usersNotified: string[] = []

    try {
        console.log("Getting list of all stored job searches...")
        await db.query(
            `
            SELECT js.user_id, js.keyword, js.location, js.language, t.token, t.platform
            FROM job_searches js
            INNER JOIN tokens t ON js.user_id = t.user_id
            WHERE js.user_removed = FALSE
            `,
            []
        )
            .then(async (jobSearches: QueryResult) => {
                console.log("Checking for new job postings...")
                // for each job search, check if there's new job postings //
                jobSearches.rows.forEach(async (row: any) => {
                    console.log(`keyword: ${row.keyword}, location: ${row.location}, user: ${row.user_id}`)
                    try {
                        const jobsResp = await jobsApi.get(
                            "Jobs/SearchJobs",
                            {
                                data: {
                                    jobTitle: row.keyword,
                                    location: row.location,
                                    language: row.language,
                                    minimumPostedDate: minimumPostedDate
                                }
                            }
                        )

                        // if there is new job postings, and the user hasn't been sent a push notification yet, send them one //
                        if (jobsResp.data.count > 0 && !usersNotified.includes(row.user_id)) {
                            usersNotified.push(row.user_id)
                            try {
                                await notificationsApi.post(
                                    "Messaging/Send",
                                    {
                                        title: row.language.toUpperCase() === "EN"
                                            ? "New Jobs Posted"
                                            : "Nouvelles offres d'emploi",
                                        content: row.language.toUpperCase() === "EN"
                                            ? "There are new job postings for one or more of your saved job searches!"
                                            : "Il y a de nouvelles offres d’emploi pour une ou plusieurs de vos recherches d’emploi sauvegardées!",
                                        token: row.token,
                                        platform: row.platform,
                                        dryRun: false
                                    },
                                    {
                                        auth: {
                                            username: process.env.NOTIFICATIONS_API_USER || "",
                                            password: process.env.NOTIFICATIONS_API_PASS || ""
                                        }
                                    }
                                )
                            } catch (e: any) {
                                console.log("Error sending notification. Message: ", e.message)
                            }
                        }
                    } catch (e: any) {
                        console.log("Error searching jobs. Message: ", e.message)
                    }
                })
            })

        console.log("===== END CRON JOB =====")
    } catch (e: any) {
        console.log(e.message)
    }
}, {
    scheduled: true,
    timezone: "America/Los_Angeles"
    }
)
